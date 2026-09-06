import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class CareerGraphService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async getGraph(userId: string) {
    const user =
      await this.prisma.user.findUnique({
        where: { id: userId },
        include: {
          profile: true,
          educations: {
            orderBy: {
              startDate: 'desc',
            },
          },
          experiences: {
            include: {
              company: true,
              skills: {
                include: {
                  skill: true,
                },
              },
              projects: {
                include: {
                  project: true,
                },
              },
              achievements: {
                include: {
                  achievement: true,
                },
              },
              evidence: {
                include: {
                  evidence: true,
                },
              },
            },
            orderBy: {
              startDate: 'desc',
            },
          },
          projects: {
            include: {
              skills: {
                include: {
                  skill: true,
                },
              },
              achievements: {
                include: {
                  achievement: true,
                },
              },
              evidence: {
                include: {
                  evidence: true,
                },
              },
            },
            orderBy: {
              startDate: 'desc',
            },
          },
          userSkills: {
            include: {
              skill: true,
            },
          },
          achievements: {
            include: {
              evidence: {
                include: {
                  evidence: true,
                },
              },
            },
            orderBy: {
              occurredAt: 'desc',
            },
          },
          evidence: {
            include: {
              /*
               * Enough of the import to name the source without the
               * client having to parse it out of Evidence.title.
               * extractionResult is deliberately excluded.
               */
              resumeImport: {
                select: {
                  id: true,
                  fileName: true,
                  status: true,
                  createdAt: true,
                },
              },
              /*
               * Join rows already carry the stable ids; these selects add
               * just the display name so the client never has to match
               * entities by name.
               */
              experiences: {
                include: {
                  experience: {
                    select: {
                      id: true,
                      title: true,
                    },
                  },
                },
              },
              projects: {
                include: {
                  project: {
                    select: {
                      id: true,
                      name: true,
                    },
                  },
                },
              },
              skills: {
                include: {
                  skill: {
                    select: {
                      id: true,
                      name: true,
                    },
                  },
                },
              },
              achievements: {
                include: {
                  achievement: {
                    select: {
                      id: true,
                      title: true,
                    },
                  },
                },
              },
            },
            orderBy: {
              capturedAt: 'desc',
            },
          },
          goals: true,
        },
      });

    if (!user) {
      throw new NotFoundException(
        'User not found',
      );
    }

    return user;
  }
}
