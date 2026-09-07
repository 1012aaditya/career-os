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

  /*
   * Ordering contract.
   *
   * Every collection returned here is deterministically ordered, because
   * the mobile graph draws only a capped slice of each one — an unstable
   * order would change WHICH records the user sees between refreshes.
   *
   *   - Dated collections sort newest first with NULLS LAST. Postgres
   *     defaults DESC to NULLS FIRST, which put undated records at the top
   *     and let them consume the graph's capped slots ahead of real ones.
   *   - Every ordering ends on a unique column, so ties can never resolve
   *     differently between calls.
   *   - userSkills is ordered by when the skill was attached; it carries
   *     no date of its own and any other key would imply a ranking.
   */
  async getGraph(userId: string) {
    const user =
      await this.prisma.user.findUnique({
        where: { id: userId },
        include: {
          profile: true,
          educations: {
            include: {
              evidence: {
                include: {
                  evidence: true,
                },
              },
            },
            orderBy: [
              {
                startDate: {
                  sort: 'desc',
                  nulls: 'last',
                },
              },
              { createdAt: 'desc' },
              { id: 'asc' },
            ],
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
            orderBy: [
              {
                startDate: {
                  sort: 'desc',
                  nulls: 'last',
                },
              },
              { createdAt: 'desc' },
              { id: 'asc' },
            ],
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
            orderBy: [
              {
                startDate: {
                  sort: 'desc',
                  nulls: 'last',
                },
              },
              { createdAt: 'desc' },
              { id: 'asc' },
            ],
          },
          /*
           * Previously unordered entirely, so Postgres was free to return
           * skills in any order — which decided WHICH skills the capped
           * graph drew and where they sat.
           */
          userSkills: {
            include: {
              skill: true,
            },
            orderBy: [
              { createdAt: 'asc' },
              { skillId: 'asc' },
            ],
          },
          achievements: {
            include: {
              evidence: {
                include: {
                  evidence: true,
                },
              },
            },
            orderBy: [
              {
                occurredAt: {
                  sort: 'desc',
                  nulls: 'last',
                },
              },
              { createdAt: 'desc' },
              { id: 'asc' },
            ],
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
              educations: {
                include: {
                  education: {
                    select: {
                      id: true,
                      institution: true,
                    },
                  },
                },
              },
            },
            orderBy: [
              { capturedAt: 'desc' },
              { id: 'asc' },
            ],
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
