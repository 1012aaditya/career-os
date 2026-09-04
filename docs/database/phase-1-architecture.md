# Database Architecture — Phase 1

## Purpose

Define the canonical Career Capital domain before implementing the Prisma schema.

## Design Principles

1. The database stores career facts and provenance.
2. Derived intelligence is not stored as canonical career truth.
3. Supabase Auth owns authentication.
4. Application User data is keyed by the Supabase Auth user UUID.
5. Company and Skill are canonical reusable entities.
6. Career Graph data is source-independent.
7. Resume, GitHub, LinkedIn, portfolio, and manual input are sources of information, not the canonical career model.
8. Evidence is a first-class object with provenance.
9. Evidence can support multiple career facts.
10. AI-derived scores and skill proficiency are not canonical fields in Phase 1.
11. Avoid premature generalized knowledge-graph abstractions.
12. Historical occurrence time is distinct from evidence capture time.
13. User-owned records must have an explicit ownership path suitable for future authorization and Row Level Security.

## Core Models

### User

Application-level identity.

The primary key corresponds to the Supabase Auth user UUID.

Authentication credentials are not stored here.

### Profile

One-to-one presentation and identity information for a user.

Profile must not duplicate career history.

### Company

Canonical reusable company entity.

Multiple users may reference the same company.

### Experience

A user's career timeline entry.

Examples:

- Employment
- Founder
- Freelance
- Education
- Volunteer
- Other

An Experience may optionally reference a Company.

### Project

An independently meaningful project.

A project may exist outside employment and may span multiple experiences.

### Skill

Canonical reusable skill.

Examples:

- TypeScript
- PostgreSQL
- Redis
- React
- System Design

Skill does not contain user-specific proficiency.

### UserSkill

Represents the relationship between a user and a canonical Skill.

It indicates that the skill is part of the user's career profile.

No arbitrary proficiency score is stored.

### Achievement

A user-owned career outcome or accomplishment.

Examples:

- Reduced API latency by 42%.
- Led migration of three services.
- Built a production payment system.

### Evidence

An observable artifact supporting career facts.

Possible sources include:

- Manual
- Resume
- GitHub
- Portfolio
- LinkedIn
- Certification
- Document
- Other

Evidence should preserve provenance and distinguish when an event occurred from when Career OS captured it.

### Goal

A user career objective.

Actions, recommendations, opportunities, and outcomes belong to later milestones.

## Relationships

```text
User 1 ── 1 Profile

User 1 ── N Experience
User 1 ── N Project
User 1 ── N UserSkill
User 1 ── N Achievement
User 1 ── N Evidence
User 1 ── N Goal

Experience N ── 1 Company (optional)

Experience N ── N Project
Experience N ── N Skill
Project N ── N Skill

UserSkill N ── 1 Skill

Experience N ── N Achievement
Project N ── N Achievement

Evidence N ── N Experience
Evidence N ── N Project
Evidence N ── N Skill
Evidence N ── N Achievement