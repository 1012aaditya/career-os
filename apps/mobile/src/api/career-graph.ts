import { apiRequest } from './client';

/*
 * Types for GET /career-graph.
 *
 * These mirror exactly what CareerGraphService.getGraph() selects — Prisma
 * scalars serialised to JSON, plus the relations that query includes.
 * Nothing here is aspirational: if the API does not return a field, it is
 * not declared.
 *
 * Note that the payload is the User row, and the User model has no email
 * column, so no email is returned.
 */

/** Prisma DateTime serialised over JSON. */
export type IsoDateString = string;

export type ExperienceType =
  | 'EMPLOYMENT'
  | 'FOUNDER'
  | 'FREELANCE'
  | 'EDUCATION'
  | 'VOLUNTEER'
  | 'OTHER';

export type EvidenceSourceType =
  | 'MANUAL'
  | 'RESUME'
  | 'GITHUB'
  | 'PORTFOLIO'
  | 'LINKEDIN'
  | 'CERTIFICATION'
  | 'DOCUMENT'
  | 'OTHER';

export type ResumeImportStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'NEEDS_REVIEW'
  | 'CONFIRMED'
  | 'FAILED';

export type Profile = {
  id: string;
  userId: string;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  bio: string | null;
  location: string | null;
  avatarUrl: string | null;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
};

export type EducationEvidenceLink = {
  evidenceId: string;
  educationId: string;
  evidence: EvidenceRecord;
};

export type Education = {
  id: string;
  userId: string;
  institution: string;
  location: string | null;
  degree: string | null;
  fieldOfStudy: string | null;
  startDate: IsoDateString | null;
  endDate: IsoDateString | null;
  grade: string | null;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
  evidence: EducationEvidenceLink[];
};

export type Company = {
  id: string;
  name: string;
  normalizedName: string;
  websiteUrl: string | null;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
};

export type Skill = {
  id: string;
  name: string;
  normalizedName: string;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
};

/** Project scalars, as returned when a project is included through a join. */
export type ProjectRecord = {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  url: string | null;
  startDate: IsoDateString | null;
  endDate: IsoDateString | null;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
};

/** Achievement scalars, as returned when included through a join. */
export type AchievementRecord = {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  occurredAt: IsoDateString | null;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
};

/** Evidence scalars, as returned when included through a join. */
export type EvidenceRecord = {
  id: string;
  userId: string;
  resumeImportId: string | null;
  sourceType: EvidenceSourceType;
  title: string;
  description: string | null;
  sourceUrl: string | null;
  externalId: string | null;
  /** When the thing happened. Null on resume-import evidence. */
  occurredAt: IsoDateString | null;
  /** When the record was ingested. Never a career date. */
  capturedAt: IsoDateString;
  metadata: unknown;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
};

/*
 * Join rows. Each carries the stable ids of both sides; the hydrated
 * relation is present only where getGraph includes it.
 */

export type ExperienceSkillLink = {
  experienceId: string;
  skillId: string;
  skill: Skill;
};

export type ExperienceProjectLink = {
  experienceId: string;
  projectId: string;
  project: ProjectRecord;
};

export type ExperienceAchievementLink = {
  experienceId: string;
  achievementId: string;
  achievement: AchievementRecord;
};

export type ExperienceEvidenceLink = {
  evidenceId: string;
  experienceId: string;
  evidence: EvidenceRecord;
};

export type ProjectSkillLink = {
  projectId: string;
  skillId: string;
  skill: Skill;
};

export type ProjectAchievementLink = {
  projectId: string;
  achievementId: string;
  achievement: AchievementRecord;
};

export type ProjectEvidenceLink = {
  evidenceId: string;
  projectId: string;
  evidence: EvidenceRecord;
};

export type AchievementEvidenceLink = {
  evidenceId: string;
  achievementId: string;
  evidence: EvidenceRecord;
};

export type Experience = {
  id: string;
  userId: string;
  companyId: string | null;
  type: ExperienceType;
  title: string;
  description: string | null;
  location: string | null;
  startDate: IsoDateString | null;
  endDate: IsoDateString | null;
  /*
   * The end date exactly as the source wrote it. Distinguishes a source
   * that stated the role is ongoing from one that simply omitted an end
   * date — isCurrent alone cannot.
   */
  endDateText: string | null;
  isCurrent: boolean;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
  company: Company | null;
  skills: ExperienceSkillLink[];
  /*
   * Populated from ExperienceProject / ExperienceAchievement. Ingestion
   * does not currently write those tables, so in practice these arrive
   * empty — the API shape allows them, the data does not yet exist.
   */
  projects: ExperienceProjectLink[];
  achievements: ExperienceAchievementLink[];
  evidence: ExperienceEvidenceLink[];
};

export type Project = ProjectRecord & {
  skills: ProjectSkillLink[];
  achievements: ProjectAchievementLink[];
  evidence: ProjectEvidenceLink[];
};

export type Achievement = AchievementRecord & {
  evidence: AchievementEvidenceLink[];
};

export type UserSkill = {
  id: string;
  userId: string;
  skillId: string;
  createdAt: IsoDateString;
  skill: Skill;
};

export type Goal = {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  targetDate: IsoDateString | null;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
};

/*
 * Top-level evidence. Its joins are hydrated with just the id and display
 * name of the related entity — enough to render a link without matching on
 * names, and no more.
 */

export type EvidenceSkillRef = {
  evidenceId: string;
  skillId: string;
  skill: Pick<Skill, 'id' | 'name'>;
};

export type EvidenceExperienceRef = {
  evidenceId: string;
  experienceId: string;
  experience: Pick<Experience, 'id' | 'title'>;
};

export type EvidenceProjectRef = {
  evidenceId: string;
  projectId: string;
  project: Pick<ProjectRecord, 'id' | 'name'>;
};

export type EvidenceEducationRef = {
  evidenceId: string;
  educationId: string;
  education: Pick<Education, 'id' | 'institution'>;
};

export type EvidenceAchievementRef = {
  evidenceId: string;
  achievementId: string;
  achievement: Pick<
    AchievementRecord,
    'id' | 'title'
  >;
};

/** Only the fields getGraph selects — extractionResult is not exposed. */
export type EvidenceResumeImport = {
  id: string;
  fileName: string;
  status: ResumeImportStatus;
  createdAt: IsoDateString;
};

export type Evidence = EvidenceRecord & {
  resumeImport: EvidenceResumeImport | null;
  experiences: EvidenceExperienceRef[];
  projects: EvidenceProjectRef[];
  skills: EvidenceSkillRef[];
  achievements: EvidenceAchievementRef[];
  educations: EvidenceEducationRef[];
};

/*
 * The User row plus its included relations. There is no email field on the
 * User model, so the payload does not carry one.
 */
export type CareerGraph = {
  id: string;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
  profile: Profile | null;
  educations: Education[];
  experiences: Experience[];
  projects: Project[];
  userSkills: UserSkill[];
  achievements: Achievement[];
  evidence: Evidence[];
  goals: Goal[];
};

export async function getCareerGraph(): Promise<CareerGraph> {
  return apiRequest<CareerGraph>('/career-graph');
}
