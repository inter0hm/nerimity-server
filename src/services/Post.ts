import { Post, Prisma } from '@prisma/client';
import { CustomResult } from '../common/CustomResult';
import { dateToDateTime, prisma, publicUserExcludeFields } from '../common/database';
import { CustomError, generateError } from '../common/errorHandler';
import { generateId } from '../common/flakeId';
import { deleteFile } from '../common/nerimityCDN';
import { FriendStatus } from '../types/Friend';
import { getBlockedUserIds, isUserBlocked } from './User/User';
import { replaceBadWords } from '../common/badWords';
import { addPostViewsToCache } from '../cache/PostViewsCache';

function constructInclude(requesterUserId: string, continueIter = true): Prisma.PostInclude | null | undefined {
  return {
    poll: {
      select: {
        id: true,
        _count: { select: { votedUsers: true } },
        votedUsers: {
          where: { userId: requesterUserId },
          select: { pollChoiceId: true },
        },
        choices: {
          orderBy: { id: 'asc' },
          select: {
            id: true,
            content: true,
            _count: { select: { votedUsers: true } },
          },
        },
      },
    },
    ...(continueIter ? { commentTo: { include: constructInclude(requesterUserId, false) } } : undefined),
    createdBy: { select: publicUserExcludeFields },
    _count: {
      select: { likedBy: true, comments: { where: { deleted: null } } },
    },
    likedBy: { select: { id: true }, where: { likedById: requesterUserId } },
    attachments: {
      select: { height: true, width: true, path: true, id: true },
    },
  };
}

interface CreatePostOpts {
  userId: string;
  content?: string;
  commentToId?: string;
  attachment?: { width?: number; height?: number; path: string };
  poll?: { choices: string[] };
}
export async function createPost(opts: CreatePostOpts) {
  if (opts.commentToId) {
    const comment = await prisma.post.findUnique({
      where: { id: opts.commentToId },
    });
    if (!comment) {
      return [null, generateError('Comment not found')] as const;
    }
    const blockedUserIds = await getBlockedUserIds([comment.createdById], opts.userId);
    if (blockedUserIds.length) {
      return [null, generateError('You have been blocked by this user!')] as const;
    }
  }

  const post = await prisma.post.create({
    data: {
      id: generateId(),
      content: opts.content ? replaceBadWords(opts.content?.trim()) : undefined,
      createdById: opts.userId,
      ...(opts.commentToId ? { commentToId: opts.commentToId } : undefined),
      ...(opts.attachment
        ? {
            attachments: {
              create: {
                id: generateId(),
                height: opts.attachment.height,
                width: opts.attachment.width,
                path: opts.attachment.path,
              },
            },
          }
        : undefined),

      ...(opts.poll?.choices.length
        ? {
            poll: {
              create: {
                id: generateId(),
                choices: {
                  createMany: { data: opts.poll.choices.map((choice) => ({ id: generateId(), content: choice })) },
                },
              },
            },
          }
        : {}),
    },
    include: constructInclude(opts.userId),
  });

  if (opts.commentToId) {
    createPostNotification({
      byId: opts.userId,
      postId: post.id,
      type: PostNotificationType.REPLIED,
    });
  }

  return [post, null] as const;
}

export async function editPost(opts: { editById: string; postId: string; content: string }) {
  const post = await prisma.post.findFirst({
    where: { createdById: opts.editById, deleted: null, id: opts.postId },
    select: { id: true },
  });
  if (!post) return [null, generateError('Post not found')] as const;

  const newPost = await prisma.post
    .update({
      where: { id: opts.postId },
      data: {
        content: replaceBadWords(opts.content?.trim()),

        editedAt: dateToDateTime(),
      },
      include: constructInclude(opts.editById),
    })
    .catch(() => {});

  if (!newPost) return [null, generateError('Something went wrong. Try again later.')] as const;

  return [newPost, null] as const;
}

export async function getPostLikes(postId: string) {
  const post = await prisma.post.findFirst({
    where: { deleted: null, id: postId },
    select: { id: true },
  });
  if (!post) return [null, generateError('Post not found')] as const;

  const postLikedByUsers = await prisma.postLike.findMany({
    where: { postId },
    orderBy: { createdAt: 'desc' },
    select: { likedBy: true, createdAt: true },
  });

  return [postLikedByUsers, null];
}

interface FetchPostsOpts {
  userId?: string;
  postId?: string; // get comments
  requesterUserId: string;
  withReplies?: boolean;
  bypassBlocked?: boolean;

  hideIfBlockedByMe?: boolean;

  limit?: number;
  afterId?: string;
  beforeId?: string;

  where?: Prisma.PostWhereInput;
  additionalInclude?: Prisma.PostInclude;
  orderBy?: Prisma.PostOrderByWithRelationInput | Prisma.PostOrderByWithRelationInput[];
  skip?: number;
  cursor?: Prisma.PostWhereUniqueInput;
}

export async function fetchPosts(opts: FetchPostsOpts) {
  const where = {
    ...opts.where,
    ...(opts.afterId ? { id: { lt: opts.afterId } } : {}),
    ...(opts.beforeId ? { id: { gt: opts.beforeId } } : {}),

    ...(opts.userId ? { createdById: opts.userId } : undefined),
    ...(!opts.withReplies ? { commentToId: null } : undefined),
    ...(opts.postId ? { commentToId: opts.postId } : undefined),
    ...(!opts.bypassBlocked
      ? {
          createdBy: {
            ...(opts.hideIfBlockedByMe
              ? {
                  recipientFriends: {
                    none: {
                      status: FriendStatus.BLOCKED,
                      userId: opts.requesterUserId,
                    },
                  },
                }
              : {}),
            friends: {
              none: {
                status: FriendStatus.BLOCKED,
                recipientId: opts.requesterUserId,
              },
            },
          },
        }
      : undefined),
    deleted: null,
  };

  const posts = await prisma.post.findMany({
    where,
    skip: opts.skip,
    orderBy: opts.orderBy || { createdAt: 'desc' },
    take: opts.limit ? (opts.limit > 30 ? 30 : opts.limit) : 30,
    cursor: opts.cursor,
    include: { ...constructInclude(opts.requesterUserId), ...opts.additionalInclude },
  });
  updateViews(posts);

  return posts.reverse();
}
async function updateViews(posts: Post[]) {
  const ids = [...posts.map((post) => post.id), ...posts.flatMap((post) => post.commentToId ?? [])];
  if (!ids.length) return;
  addPostViewsToCache(ids, '127.0.0.1');
  // await prisma.post.updateMany({
  //   where: { id: { in: ids } },
  //   data: {
  //     views: { increment: 1 },
  //   },
  // });
}

interface fetchLinkedPostsOpts {
  userId: string;
  requesterUserId: string;
  bypassBlocked?: boolean;
}

export async function fetchLikedPosts(opts: fetchLinkedPostsOpts) {
  const likes = await prisma.postLike.findMany({
    where: {
      likedById: opts.userId,
      post: {
        ...(!opts.bypassBlocked
          ? {
              createdBy: {
                friends: {
                  none: {
                    status: FriendStatus.BLOCKED,
                    recipientId: opts.requesterUserId,
                  },
                },
              },
            }
          : undefined),
      },
    },
    include: { post: { include: constructInclude(opts.requesterUserId) } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  const posts = likes.map((like) => like.post);

  updateViews(posts);

  return posts.reverse();
}

interface fetchLatestPostOpts {
  userId: string;
  requesterUserId: string;
  bypassBlocked?: boolean;
}

export async function fetchLatestPost(opts: fetchLatestPostOpts) {
  const post = await prisma.post.findFirst({
    orderBy: { createdAt: 'desc' },
    where: {
      deleted: null,
      commentToId: null,
      createdById: opts.userId,
      ...(!opts.bypassBlocked
        ? {
            createdBy: {
              friends: {
                none: {
                  status: FriendStatus.BLOCKED,
                  recipientId: opts.requesterUserId,
                },
              },
            },
          }
        : undefined),
    },
    include: constructInclude(opts.requesterUserId),
  });

  if (!post) return null;

  updateViews([post]);

  return post;
}

type BlockedPost = Partial<Post> & { commentTo?: Post; block: true };

interface ConstructBlockedPostOpts {
  post: Post & { commentTo?: Partial<Post> };
  requesterUserId: string;
  bypassBlocked?: boolean;
}

const constructBlockedPostTemplate = async (opts: ConstructBlockedPostOpts): Promise<BlockedPost> => {
  let commentTo = opts.post.commentTo;

  if (commentTo && !opts.bypassBlocked) {
    const commentToBlocked = await isUserBlocked(opts.requesterUserId, commentTo.createdById!);

    if (commentTo && commentToBlocked) {
      commentTo = await constructBlockedPostTemplate({
        ...opts,
        post: commentTo as Post,
      });
    }
  }

  return {
    id: opts.post.id,
    commentToId: opts.post.commentToId,
    createdBy: opts.post.createdBy,
    commentTo,
    quotedPostId: opts.post.quotedPostId,
    block: true,
  } as BlockedPost;
};
interface FetchPostOpts {
  postId: string;
  requesterUserId: string;
  bypassBlocked?: boolean;
}

export async function fetchPost(opts: FetchPostOpts) {
  const post = await prisma.post.findFirst({
    where: {
      id: opts.postId,
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: constructInclude(opts.requesterUserId),
  });
  if (!post) return null;

  if (!opts.bypassBlocked) {
    const isBlocked = await isUserBlocked(opts.requesterUserId, post.createdById);
    if (isBlocked) {
      return constructBlockedPostTemplate({
        post,
        requesterUserId: opts.requesterUserId,
        bypassBlocked: opts.bypassBlocked,
      });
    }
  }

  updateViews([post]);

  return post;
}

export async function likePost(userId: string, postId: string): Promise<CustomResult<Post, CustomError>> {
  const post = await prisma.post.findFirst({
    where: { deleted: null, id: postId },
  });
  if (!post) return [null, generateError('Post not found')];

  const existingPost = await prisma.postLike.findFirst({
    where: { likedById: userId, postId },
    select: { id: true },
  });
  if (existingPost) {
    return [null, generateError('You have already liked this post!')];
  }

  const blockedUserIds = await getBlockedUserIds([post.createdById], userId);
  if (blockedUserIds.length) {
    return [null, generateError('You have been blocked by this user!')];
  }

  await prisma.post.update({
    where: { id: postId },
    data: {
      estimateLikes: {
        increment: 1,
      },
    },
  });

  const newPostLike = await prisma.postLike
    .create({
      data: {
        id: generateId(),
        likedById: userId,
        postId,
      },
    })
    .catch(() => {});
  if (!newPostLike) return [null, generateError('Something went wrong! Try again later.')];

  const newPost = (await fetchPost({
    postId,
    requesterUserId: userId,
  })) as Post;

  createPostNotification({
    type: PostNotificationType.LIKED,
    byId: userId,
    postId,
  });

  return [newPost, null];
}

export async function unlikePost(userId: string, postId: string): Promise<CustomResult<Post, CustomError>> {
  const postLike = await prisma.postLike.findFirst({
    where: { likedById: userId, postId },
  });
  if (!postLike) {
    return [null, generateError('You have not liked this post!')];
  }

  await prisma.post.update({
    where: { id: postId },
    data: {
      estimateLikes: {
        decrement: 1,
      },
    },
  });

  await prisma.postLike.delete({
    where: { id: postLike.id },
  });
  const newPost = (await fetchPost({
    postId,
    requesterUserId: userId,
  })) as Post;
  return [newPost, null];
}

export async function deletePost(postId: string, userId: string): Promise<CustomResult<boolean, CustomError>> {
  const post = await prisma.post.findFirst({
    where: { id: postId, createdById: userId },
    include: { attachments: true },
  });
  if (!post) {
    return [null, generateError('Post does not exist!')];
  }

  if (post.attachments?.[0]?.path) {
    deleteFile(post.attachments[0].path);
  }

  await prisma.$transaction([
    prisma.post.update({
      where: { id: postId },
      data: {
        content: null,
        deleted: true,
        estimateLikes: 0,
      },
    }),
    prisma.postLike.deleteMany({ where: { postId } }),
    prisma.postPoll.deleteMany({ where: { postId } }),
    prisma.attachment.deleteMany({ where: { postId } }),
    prisma.announcementPost.deleteMany({ where: { postId } }),
  ]);

  return [true, null];
}

interface GetFeedOpts {
  userId: string;
  afterId?: string;
  beforeId?: string;
  limit?: number;
}

export async function getFeed(opts: GetFeedOpts) {
  const feedPosts = await prisma.post.findMany({
    orderBy: { createdAt: 'desc' },
    where: {
      ...(opts.afterId ? { id: { lt: opts.afterId } } : {}),
      ...(opts.beforeId ? { id: { gt: opts.beforeId } } : {}),

      commentTo: null,
      deleted: null,
      OR: [
        { createdById: opts.userId },
        {
          createdBy: {
            followers: {
              some: { followedById: opts.userId },
            },
          },
        },
      ],
    },
    include: constructInclude(opts.userId),
    take: opts.limit ? (opts.limit > 30 ? 30 : opts.limit) : 30,
  });

  updateViews(feedPosts);
  return feedPosts;
}

export enum PostNotificationType {
  LIKED = 0,
  REPLIED = 1,
  FOLLOWED = 2,
}

interface CreatePostNotificationProps {
  toId?: string;
  byId: string;
  postId?: string;
  type: PostNotificationType;
}

export async function createPostNotification(opts: CreatePostNotificationProps) {
  let toId = opts.toId;

  if (opts.type === PostNotificationType.LIKED || opts.type === PostNotificationType.REPLIED) {
    const post = await prisma.post.findFirst({
      where: { id: opts.postId },
      select: { createdById: true },
    });
    if (!post) return;
    toId = post.createdById;
  }

  if (opts.type === PostNotificationType.REPLIED) {
    const post = await prisma.post.findFirst({
      where: { id: opts.postId },
      select: { commentTo: { select: { createdById: true } } },
    });
    if (!post) return;
    toId = post.commentTo?.createdById;
  }

  if (!toId) return;

  if (toId === opts.byId) return;

  const alreadyExists = await prisma.postNotification.findFirst({
    where: {
      byId: opts.byId,
      toId: toId,
      type: opts.type,
      postId: opts.postId,
    },
  });
  if (alreadyExists) return;

  await prisma
    .$transaction([
      prisma.postNotification.create({
        data: {
          id: generateId(),
          byId: opts.byId,
          toId: toId,
          type: opts.type,
          postId: opts.postId,
        },
      }),
      prisma.account.update({
        where: { userId: toId },
        data: {
          postNotificationCount: { increment: 1 },
        },
      }),
    ])

    .catch(() => {});

  // // delete if more than 10 notifications exist
  // const tenthLatestRecord = await prisma.postNotification.findFirst({
  //   take: 1,
  //   skip: 9,
  //   where: {toId},
  //   orderBy: {id: 'desc'},
  //   select: {id: true}
  // });

  // if (!tenthLatestRecord) return;

  // await prisma.postNotification.deleteMany({
  //   where: { id: { lt: tenthLatestRecord.id}, toId }
  // });
}

export async function getPostNotifications(userId: string) {
  const notifications = await prisma.postNotification.findMany({
    orderBy: { createdAt: 'desc' },
    where: { toId: userId },
    take: 20,
    include: {
      by: true,
      post: { include: constructInclude(userId) },
    },
  });
  const posts = notifications.filter((n) => n.type === PostNotificationType.REPLIED).map((n) => n.post!);

  updateViews(posts);

  return notifications;
}

export async function getPostNotificationCount(userId: string) {
  const account = await prisma.account.findFirst({
    where: { userId },
    select: { postNotificationCount: true },
  });
  return account?.postNotificationCount;
}
export async function dismissPostNotification(userId: string) {
  await prisma.account.update({
    where: { userId },
    data: { postNotificationCount: 0 },
  });
}

export async function votePostPoll(requesterId: string, postId: string, pollId: string, choiceId: string) {
  const poll = await prisma.postPoll.findUnique({
    where: { postId, id: pollId },
    select: {
      post: {
        select: {
          createdBy: {
            select: {
              id: true,
            },
          },
        },
      },
    },
  });

  if (!poll) {
    return [null, generateError('Poll not found.')] as const;
  }

  const blockedUserIds = await getBlockedUserIds([poll?.post.createdBy.id], requesterId);
  if (blockedUserIds.length) {
    return [null, generateError('You have been blocked by this user!')] as const;
  }

  const choice = await prisma.postPollChoice.findUnique({
    where: { pollId, id: choiceId },
  });
  if (!choice) {
    return [null, generateError('Poll not found.')] as const;
  }

  const alreadyVoted = await prisma.postPollVotedUser.findFirst({
    where: { userId: requesterId, pollId },
    select: { id: true },
  });

  if (alreadyVoted) {
    return [null, generateError('Already voted.')] as const;
  }

  await prisma.postPollVotedUser.create({
    data: {
      id: generateId(),
      userId: requesterId,
      pollId,
      pollChoiceId: choiceId,
    },
    select: { id: true },
  });
  return [true, null] as const;
}

export async function addAnnouncementPost(postId: string) {
  return await prisma.announcementPost.create({
    data: {
      postId,
    },
  });
}

export async function getAnnouncementPosts(requesterId: string) {
  const feedPosts = await prisma.post.findMany({
    orderBy: { createdAt: 'desc' },
    where: {
      NOT: {
        announcement: null,
      },
    },
    include: constructInclude(requesterId),
  });

  updateViews(feedPosts);
  return feedPosts;
}

export async function removeAnnouncementPost(postId: string) {
  return await prisma.announcementPost.delete({
    where: {
      postId,
    },
  });
}
