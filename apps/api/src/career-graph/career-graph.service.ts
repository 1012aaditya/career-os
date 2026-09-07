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
   *
   * NESTED collections are ordered too, by the foreign key that varies
   * within the parent. Only the top-level lists used to carry an orderBy,
   * so the contract above was true of them and false of everything one
   * level down: Postgres was free to return an experience's skills, or an
   * evidence row's links, in any order it liked. That order reaches the
   * user — EvidenceCard renders the first six links and a "+N more" line —
   * so the same graph could show a different six between refreshes.
   *
   * The join tables have no createdAt and no rank column (see
   * schema.prisma), so there is no meaningful order to restore; the FK is
   * chosen because it is the only column that is both present and unique
   * within a parent. It sorts by an opaque uuid, which is arbitrary but
   * STABLE — and stable is the whole requirement. Clients that need a
   * meaningful order sort by display name themselves.
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
                orderBy: [
                  { evidenceId: 'asc' },
                ],
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
                orderBy: [
                  { skillId: 'asc' },
                ],
              },
              projects: {
                include: {
                  project: true,
                },
                orderBy: [
                  { projectId: 'asc' },
                ],
              },
              achievements: {
                include: {
                  achievement: true,
                },
                orderBy: [
                  { achievementId: 'asc' },
                ],
              },
              evidence: {
                include: {
                  evidence: true,
                },
                orderBy: [
                  { evidenceId: 'asc' },
                ],
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
                orderBy: [
                  { skillId: 'asc' },
                ],
              },
              achievements: {
                include: {
                  achievement: true,
                },
                orderBy: [
                  { achievementId: 'asc' },
                ],
              },
              evidence: {
                include: {
                  evidence: true,
                },
                orderBy: [
                  { evidenceId: 'asc' },
                ],
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
                orderBy: [
                  { evidenceId: 'asc' },
                ],
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
                orderBy: [
                  { experienceId: 'asc' },
                ],
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
                orderBy: [
                  { projectId: 'asc' },
                ],
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
                orderBy: [
                  { skillId: 'asc' },
                ],
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
                orderBy: [
                  { achievementId: 'asc' },
                ],
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
                orderBy: [
                  { educationId: 'asc' },
                ],
              },
            },
            orderBy: [
              { capturedAt: 'desc' },
              { id: 'asc' },
            ],
          },
          /*
           * Ordered like the other dated top-level collections. It was the
           * one that never carried an orderBy at all.
           */
          goals: {
            orderBy: [
              {
                targetDate: {
                  sort: 'desc',
                  nulls: 'last',
                },
              },
              { createdAt: 'desc' },
              { id: 'asc' },
            ],
          },
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
