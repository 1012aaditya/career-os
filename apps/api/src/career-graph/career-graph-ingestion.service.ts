import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

type ResumeExtraction = {
  extraction?: {
    basics?: {
      name?: string;
      email?: string;
      phone?: string;
      github?: string;
      linkedin?: string;
      portfolio?: string;
    };

    education?: Array<{
      institution?: string;
      location?: string;
      degree?: string;
      field_of_study?: string;
      start_date?: string;
      end_date?: string;
      grade?: string;
    }>;

    skills?: string[];

    projects?: Array<{
      name?: string;
      description?: string;
      start_date?: string;
      end_date?: string;
      technologies?: string[];
    }>;

    experience?: Array<{
      company?: string;
      role?: string;
      location?: string;
      start_date?: string;
      end_date?: string;
      description?: string;
      technologies?: string[];
    }>;

    achievements?: Array<{
      title?: string;
      description?: string;
      date?: string;
    }>;
  };
};

@Injectable()
export class CareerGraphIngestionService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async ingestConfirmedResume(
    userId: string,
    resumeImportId: string,
  ) {
    const resumeImport =
      await this.prisma.resumeImport.findFirst({
        where: {
          id: resumeImportId,
          userId,
        },
      });

    if (!resumeImport) {
      throw new NotFoundException(
        'Resume import not found',
      );
    }

    if (resumeImport.status !== 'CONFIRMED') {
      throw new ConflictException(
        'Only confirmed resumes can be ingested',
      );
    }

    if (!resumeImport.extractionResult) {
      throw new ConflictException(
        'Resume import has no extraction result',
      );
    }

    const existingIngestion =
      await this.prisma.careerGraphIngestion.findUnique({
        where: {
          resumeImportId: resumeImport.id,
        },
      });

    if (existingIngestion) {
      return {
        resumeImportId: resumeImport.id,
        ingestionId: existingIngestion.id,
        status: 'ALREADY_INGESTED',
      };
    }

    const result =
      resumeImport.extractionResult as ResumeExtraction;

    const extraction = result.extraction;

    if (!extraction) {
      throw new BadRequestException(
        'Resume extraction is missing extraction data',
      );
    }

    return this.prisma.$transaction(
      async (tx) => {
        /*
         * Double-check idempotency inside the transaction.
         * This protects against two ingestion requests arriving
         * at almost the same time.
         */
        const existing =
          await tx.careerGraphIngestion.findUnique({
            where: {
              resumeImportId: resumeImport.id,
            },
          });

        if (existing) {
          return {
            resumeImportId: resumeImport.id,
            ingestionId: existing.id,
            status: 'ALREADY_INGESTED',
          };
        }

        /*
         * ------------------------------------------------------
         * PROFILE
         * ------------------------------------------------------
         */

        const basics =
          extraction.basics ?? {};

        if (basics.name?.trim()) {
          const parts = basics.name
            .trim()
            .split(/\s+/);

          const firstName =
            parts.shift() ?? null;

          const lastName =
            parts.length > 0
              ? parts.join(' ')
              : null;

          await tx.profile.upsert({
            where: {
              userId,
            },
            create: {
              userId,
              firstName,
              lastName,
            },
            update: {
              firstName,
              lastName,
            },
          });
        }

        /*
         * ------------------------------------------------------
         * SKILLS
         * ------------------------------------------------------
         */

        const allSkills = [
          ...(extraction.skills ?? []),

          ...(extraction.projects ?? []).flatMap(
            (project) =>
              project.technologies ?? [],
          ),

          ...(extraction.experience ?? []).flatMap(
            (experience) =>
              experience.technologies ?? [],
          ),
        ];

        const skillIds =
          new Map<string, string>();

        for (const rawSkill of allSkills) {
          const name =
            rawSkill?.trim();

          if (!name) {
            continue;
          }

          const normalizedName =
            this.normalizeName(name);

          if (skillIds.has(normalizedName)) {
            continue;
          }

          const skill =
            await tx.skill.upsert({
              where: {
                normalizedName,
              },
              create: {
                name,
                normalizedName,
              },
              update: {},
            });

          skillIds.set(
            normalizedName,
            skill.id,
          );

          await tx.userSkill.upsert({
            where: {
              userId_skillId: {
                userId,
                skillId: skill.id,
              },
            },
            create: {
              userId,
              skillId: skill.id,
            },
            update: {},
          });
        }

        /*
         * ------------------------------------------------------
         * EDUCATION
         * ------------------------------------------------------
         */

        const educationRecords = [];

        for (const education of
          extraction.education ?? []) {
          if (!education.institution?.trim()) {
            continue;
          }

          const institution =
            education.institution.trim();

          const degree =
            this.optionalString(
              education.degree,
            );

          const fieldOfStudy =
            this.optionalString(
              education.field_of_study,
            );

          const startDate =
            this.parseDate(
              education.start_date,
            );

          const endDate =
            this.parseDate(
              education.end_date,
            );

          let existingEducation =
            await tx.education.findFirst({
              where: {
                userId,
                institution,
                degree,
                fieldOfStudy,
                startDate,
                endDate,
              },
            });

          if (!existingEducation) {
            existingEducation =
              await tx.education.create({
                data: {
                  userId,
                  institution,
                  location:
                    this.optionalString(
                      education.location,
                    ),
                  degree,
                  fieldOfStudy,
                  startDate,
                  endDate,
                  grade:
                    this.optionalString(
                      education.grade,
                    ),
                },
              });
          }

          educationRecords.push(
            existingEducation,
          );
        }

        /*
         * ------------------------------------------------------
         * EXPERIENCES
         * ------------------------------------------------------
         */

        const experienceRecords = [];

        for (const experience of
          extraction.experience ?? []) {
          if (!experience.role?.trim()) {
            continue;
          }

          let companyId:
            | string
            | undefined;

          if (experience.company?.trim()) {
            const normalizedCompany =
              this.normalizeName(
                experience.company,
              );

            const company =
              await tx.company.upsert({
                where: {
                  normalizedName:
                    normalizedCompany,
                },
                create: {
                  name:
                    experience.company.trim(),
                  normalizedName:
                    normalizedCompany,
                },
                update: {},
              });

            companyId = company.id;
          }

          const title =
            experience.role.trim();

          const description =
            this.optionalString(
              experience.description,
            );

          const location =
            this.optionalString(
              experience.location,
            );

          const startDate =
            this.parseDate(
              experience.start_date,
            );

          const endDate =
            this.parseDate(
              experience.end_date,
            );

          const rawEndDate =
            experience.end_date?.trim() ?? '';

          const saysOngoing =
            this.isOngoingMarker(rawEndDate);

          /*
           * companyId is `string | undefined`. Prisma DROPS an undefined
           * field from a where clause rather than matching NULL, so an
           * experience with no company would otherwise match a row at ANY
           * company and silently inherit that employer.
           */
          let existingExperience =
            await tx.experience.findFirst({
              where: {
                userId,
                companyId: companyId ?? null,
                title,
                startDate,
                endDate,
              },
            });

          if (!existingExperience) {
            existingExperience =
              await tx.experience.create({
                data: {
                  userId,
                  companyId,
                  type: 'EMPLOYMENT',
                  title,
                  description,
                  location,
                  startDate,
                  endDate,
                  /*
                   * Current only when the source SAYS so, or says nothing.
                   *
                   * Three distinct cases hide behind one boolean, and
                   * conflating them fabricates career state either way:
                   *
                   *   - an explicit ongoing marker ("Present", "Current")
                   *     is the source asserting the role is open;
                   *   - no end date at all is the source omitting it, so
                   *     treating the role as open is an inference — a
                   *     reasonable one, and the resume convention;
                   *   - an end date we simply could not parse ("2021 -
                   *     2022", "Jun 2021 – Aug 2022", "N/A") is NOT
                   *     evidence of anything. Those are usually ended
                   *     roles, and marking them current would invent a
                   *     job the user does not hold.
                   *
                   * The third case therefore yields endDate: null and
                   * isCurrent: false — a record that states neither, which
                   * the mobile data-quality projection surfaces for review
                   * rather than guessing at.
                   */
                  isCurrent: saysOngoing || !rawEndDate,
                },
              });
          }

          experienceRecords.push(
            existingExperience,
          );

          /*
           * Connect experience → skills.
           */

          for (const rawSkill of
            experience.technologies ?? []) {
            const name =
              rawSkill?.trim();

            if (!name) {
              continue;
            }

            const skillId =
              skillIds.get(
                this.normalizeName(name),
              );

            if (!skillId) {
              continue;
            }

            await tx.experienceSkill.upsert({
              where: {
                experienceId_skillId: {
                  experienceId:
                    existingExperience.id,
                  skillId,
                },
              },
              create: {
                experienceId:
                  existingExperience.id,
                skillId,
              },
              update: {},
            });
          }
        }

        /*
         * ------------------------------------------------------
         * PROJECTS
         * ------------------------------------------------------
         */

        const projectRecords = [];

        for (const project of
          extraction.projects ?? []) {
          if (!project.name?.trim()) {
            continue;
          }

          const name =
            project.name.trim();

          const description =
            this.optionalString(
              project.description,
            );

          const startDate =
            this.parseDate(
              project.start_date,
            );

          const endDate =
            this.parseDate(
              project.end_date,
            );

          let existingProject =
            await tx.project.findFirst({
              where: {
                userId,
                name,
                startDate,
                endDate,
              },
            });

          if (!existingProject) {
            existingProject =
              await tx.project.create({
                data: {
                  userId,
                  name,
                  description,
                  startDate,
                  endDate,
                },
              });
          }

          projectRecords.push(
            existingProject,
          );

          /*
           * Connect project → skills.
           */

          for (const rawSkill of
            project.technologies ?? []) {
            const skillName =
              rawSkill?.trim();

            if (!skillName) {
              continue;
            }

            const skillId =
              skillIds.get(
                this.normalizeName(
                  skillName,
                ),
              );

            if (!skillId) {
              continue;
            }

            await tx.projectSkill.upsert({
              where: {
                projectId_skillId: {
                  projectId:
                    existingProject.id,
                  skillId,
                },
              },
              create: {
                projectId:
                  existingProject.id,
                skillId,
              },
              update: {},
            });
          }
        }

        /*
         * ------------------------------------------------------
         * ACHIEVEMENTS
         * ------------------------------------------------------
         */

        const achievementRecords = [];

        for (const achievement of
          extraction.achievements ?? []) {
          if (!achievement.title?.trim()) {
            continue;
          }

          const title =
            achievement.title.trim();

          const description =
            this.optionalString(
              achievement.description,
            );

          const occurredAt =
            this.parseDate(
              achievement.date,
            );

          let existingAchievement =
            await tx.achievement.findFirst({
              where: {
                userId,
                title,
                occurredAt,
              },
            });

          if (!existingAchievement) {
            existingAchievement =
              await tx.achievement.create({
                data: {
                  userId,
                  title,
                  description,
                  occurredAt,
                },
              });
          }

          achievementRecords.push(
            existingAchievement,
          );
        }

        /*
         * ------------------------------------------------------
         * RESUME EVIDENCE
         * ------------------------------------------------------
         */

        const evidence =
          await tx.evidence.create({
            data: {
              userId,
              resumeImportId:
                resumeImport.id,
              sourceType: 'RESUME',
              title:
                `Resume: ${resumeImport.fileName}`,
              description:
                'Career information extracted from a confirmed resume.',
              metadata: {
                resumeImportId:
                  resumeImport.id,
              },
            },
          });

        /*
         * ------------------------------------------------------
         * EVIDENCE → SKILLS
         * ------------------------------------------------------
         */

        for (const skillId of
          skillIds.values()) {
          await tx.evidenceSkill.create({
            data: {
              evidenceId: evidence.id,
              skillId,
            },
          });
        }

        /*
         * ------------------------------------------------------
         * EVIDENCE → EXPERIENCES
         * ------------------------------------------------------
         */

        /*
         * Deduplicated by id: the records array is appended on the match
         * path as well as the create path, so two resume entries that
         * resolve to the same row would otherwise issue two inserts with
         * the same composite primary key, fail on the unique constraint,
         * and roll back the entire import.
         */
        for (const experienceId of this.distinctIds(
          experienceRecords,
        )) {
          await tx.evidenceExperience.create({
            data: {
              evidenceId: evidence.id,
              experienceId,
            },
          });
        }

        /*
         * ------------------------------------------------------
         * EVIDENCE → PROJECTS
         * ------------------------------------------------------
         */

        /*
         * Deduplicated by id: the records array is appended on the match
         * path as well as the create path, so two resume entries that
         * resolve to the same row would otherwise issue two inserts with
         * the same composite primary key, fail on the unique constraint,
         * and roll back the entire import.
         */
        for (const projectId of this.distinctIds(
          projectRecords,
        )) {
          await tx.evidenceProject.create({
            data: {
              evidenceId: evidence.id,
              projectId,
            },
          });
        }

        /*
         * ------------------------------------------------------
         * EVIDENCE → ACHIEVEMENTS
         * ------------------------------------------------------
         */

        /*
         * Deduplicated by id: the records array is appended on the match
         * path as well as the create path, so two resume entries that
         * resolve to the same row would otherwise issue two inserts with
         * the same composite primary key, fail on the unique constraint,
         * and roll back the entire import.
         */
        for (const achievementId of this.distinctIds(
          achievementRecords,
        )) {
          await tx.evidenceAchievement.create({
            data: {
              evidenceId: evidence.id,
              achievementId,
            },
          });
        }

        /*
         * ------------------------------------------------------
         * CAREER GRAPH INGESTION RECORD
         * ------------------------------------------------------
         */

        const ingestion =
          await tx.careerGraphIngestion.create({
            data: {
              resumeImportId:
                resumeImport.id,
              userId,
            },
          });

        return {
          resumeImportId:
            resumeImport.id,
          ingestionId:
            ingestion.id,
          evidenceId:
            evidence.id,
          status: 'INGESTED',
        };
      },
      {
        timeout: 120000,
        maxWait: 100000,
      },
    );
  }

  /*
   * Distinct ids in first-seen order. Order is stable because the records
   * arrays are built by iterating the extraction in document order.
   */
  private distinctIds(
    records: { id: string }[],
  ) {
    const seen = new Set<string>();

    const ids: string[] = [];

    for (const record of records) {
      if (seen.has(record.id)) {
        continue;
      }

      seen.add(record.id);
      ids.push(record.id);
    }

    return ids;
  }

  /*
   * End-date values that mean "still here". Deliberately a closed list:
   * anything outside it is treated as unreadable rather than guessed at,
   * because a wrong guess here invents current employment.
   */
  private static readonly ONGOING_MARKERS =
    new Set([
      'present',
      'current',
      'currently',
      'now',
      'ongoing',
      'to date',
      'till date',
      'to present',
      'till present',
    ]);

  private isOngoingMarker(value: string) {
    return CareerGraphIngestionService.ONGOING_MARKERS.has(
      value.toLowerCase(),
    );
  }

  private normalizeName(
    value: string,
  ) {
    return value
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  private optionalString(
    value?: string,
  ) {
    const trimmed =
      value?.trim();

    return trimmed || null;
  }

  private parseDate(
    value?: string,
  ) {
    if (!value) {
      return null;
    }

    const date =
      new Date(value);

    if (
      Number.isNaN(
        date.getTime(),
      )
    ) {
      return null;
    }

    return date;
  }
}