/*
 * Ruleset v1: the market vocabulary, and the aliases that resolve into it.
 *
 * This file IS the ruleset version. Every constant below - the role list,
 * the skill list, every alias, the seniority tokens, the ambiguous-term
 * refusals - changes what every posting is read to say. Changing any of
 * them without bumping RULESET_VERSION would silently alter the meaning of
 * numbers that have already been published, so the version is not
 * decoration and none of this may become configuration.
 *
 * Nothing here is an environment variable, and nothing here is loaded from
 * a database at normalization time. A normalizer that reads mutable state
 * is a function of that state, and its output can never be reproduced.
 *
 * Slugs are hand-authored ASCII rather than generated. Slugification is
 * locale- and Unicode-dependent, and a naive strip collapses both "C++"
 * and "C#" to "c" - which would give two distinct skills one identity.
 */

export const RULESET_VERSION = 1;

export type CanonicalTerm = { slug: string; label: string };

/*
 * Roles. Conservative and small on purpose.
 *
 * "Software Engineer", "Backend Engineer" and "Node.js Developer" are NOT
 * assumed to be the same thing, and no hierarchy relates them. Building a
 * large occupational ontology here would be inventing structure no source
 * asserts; the unresolved titles accumulate as a measurable backlog
 * instead, which is the evidence a real taxonomy would need.
 */
export const ROLES: readonly CanonicalTerm[] = [
  { slug: 'backend-engineer', label: 'Backend Engineer' },
  { slug: 'frontend-engineer', label: 'Frontend Engineer' },
  { slug: 'fullstack-engineer', label: 'Full Stack Engineer' },
  { slug: 'software-engineer', label: 'Software Engineer' },
  { slug: 'mobile-engineer', label: 'Mobile Engineer' },
  { slug: 'data-engineer', label: 'Data Engineer' },
  { slug: 'data-scientist', label: 'Data Scientist' },
  { slug: 'data-analyst', label: 'Data Analyst' },
  { slug: 'machine-learning-engineer', label: 'Machine Learning Engineer' },
  { slug: 'devops-engineer', label: 'DevOps Engineer' },
  { slug: 'site-reliability-engineer', label: 'Site Reliability Engineer' },
  { slug: 'security-engineer', label: 'Security Engineer' },
  { slug: 'qa-engineer', label: 'QA Engineer' },
  { slug: 'engineering-manager', label: 'Engineering Manager' },
  { slug: 'product-manager', label: 'Product Manager' },
  { slug: 'product-designer', label: 'Product Designer' },
  { slug: 'solutions-engineer', label: 'Solutions Engineer' },
];

/*
 * Role aliases. Keys are already folded (NFKC, casefolded, collapsed).
 *
 * An alias maps to exactly one role. Ambiguity is settled here, once, by a
 * person - never re-litigated per posting by a similarity score.
 */
export const ROLE_ALIASES: Readonly<Record<string, string>> = {
  'backend engineer': 'backend-engineer',
  'back end engineer': 'backend-engineer',
  'back-end engineer': 'backend-engineer',
  'backend developer': 'backend-engineer',
  'back end developer': 'backend-engineer',
  'backend software engineer': 'backend-engineer',
  'server side engineer': 'backend-engineer',
  'server-side engineer': 'backend-engineer',

  'frontend engineer': 'frontend-engineer',
  'front end engineer': 'frontend-engineer',
  'front-end engineer': 'frontend-engineer',
  'frontend developer': 'frontend-engineer',
  'front end developer': 'frontend-engineer',
  'frontend software engineer': 'frontend-engineer',
  'ui engineer': 'frontend-engineer',
  'web engineer': 'frontend-engineer',

  'full stack engineer': 'fullstack-engineer',
  'fullstack engineer': 'fullstack-engineer',
  'full-stack engineer': 'fullstack-engineer',
  'full stack developer': 'fullstack-engineer',
  'fullstack developer': 'fullstack-engineer',
  'full stack software engineer': 'fullstack-engineer',

  'software engineer': 'software-engineer',
  'software developer': 'software-engineer',
  'software development engineer': 'software-engineer',
  'member of technical staff': 'software-engineer',
  'systems engineer': 'software-engineer',
  'platform engineer': 'software-engineer',

  'mobile engineer': 'mobile-engineer',
  'mobile developer': 'mobile-engineer',
  'ios engineer': 'mobile-engineer',
  'ios developer': 'mobile-engineer',
  'android engineer': 'mobile-engineer',
  'android developer': 'mobile-engineer',

  'data engineer': 'data-engineer',
  'analytics engineer': 'data-engineer',
  'big data engineer': 'data-engineer',

  'data scientist': 'data-scientist',
  'research scientist': 'data-scientist',

  'data analyst': 'data-analyst',
  'business analyst': 'data-analyst',
  'business intelligence analyst': 'data-analyst',

  'machine learning engineer': 'machine-learning-engineer',
  'ml engineer': 'machine-learning-engineer',
  'ai engineer': 'machine-learning-engineer',
  'applied scientist': 'machine-learning-engineer',
  'deep learning engineer': 'machine-learning-engineer',

  'devops engineer': 'devops-engineer',
  'infrastructure engineer': 'devops-engineer',
  'cloud engineer': 'devops-engineer',

  'site reliability engineer': 'site-reliability-engineer',
  sre: 'site-reliability-engineer',

  'security engineer': 'security-engineer',
  'application security engineer': 'security-engineer',
  'information security engineer': 'security-engineer',
  'product security engineer': 'security-engineer',

  'qa engineer': 'qa-engineer',
  'quality assurance engineer': 'qa-engineer',
  'test engineer': 'qa-engineer',
  'software engineer in test': 'qa-engineer',
  'software development engineer in test': 'qa-engineer',

  'engineering manager': 'engineering-manager',
  'software engineering manager': 'engineering-manager',
  'director of engineering': 'engineering-manager',

  'product manager': 'product-manager',
  'technical product manager': 'product-manager',
  'group product manager': 'product-manager',

  'product designer': 'product-designer',
  'ux designer': 'product-designer',
  'ui designer': 'product-designer',
  'ui/ux designer': 'product-designer',

  'solutions engineer': 'solutions-engineer',
  'sales engineer': 'solutions-engineer',
  'solutions architect': 'solutions-engineer',
  'forward deployed engineer': 'solutions-engineer',
  'customer engineer': 'solutions-engineer',
};

/*
 * Seniority words removed from a title before it is resolved.
 *
 * Removed rather than modelled. Baking seniority into the role vocabulary
 * would multiply it several times over, and inventing a seniority ontology
 * now would be committing to a structure before seeing the evidence. The
 * token that was removed is kept verbatim on the normalization row, so the
 * information is preserved and the evidence accumulates.
 *
 * Longest first, so "senior staff" removes both words rather than leaving
 * "staff" behind to be read as part of the role.
 */
export const SENIORITY_TOKENS: readonly string[] = [
  'senior staff',
  'entry level',
  'early career',
  'new grad',
  'principal',
  'associate',
  'director',
  'lead',
  'senior',
  'staff',
  'junior',
  'intern',
  'sr.',
  'sr',
  'jr.',
  'jr',
  'i',
  'ii',
  'iii',
  'iv',
];

export const SKILLS: readonly CanonicalTerm[] = [
  { slug: 'typescript', label: 'TypeScript' },
  { slug: 'javascript', label: 'JavaScript' },
  { slug: 'python', label: 'Python' },
  { slug: 'java', label: 'Java' },
  { slug: 'golang', label: 'Go' },
  { slug: 'rust', label: 'Rust' },
  { slug: 'ruby', label: 'Ruby' },
  { slug: 'php', label: 'PHP' },
  { slug: 'csharp', label: 'C#' },
  { slug: 'cpp', label: 'C++' },
  { slug: 'swift', label: 'Swift' },
  { slug: 'kotlin', label: 'Kotlin' },
  { slug: 'scala', label: 'Scala' },
  { slug: 'elixir', label: 'Elixir' },
  { slug: 'sql', label: 'SQL' },

  { slug: 'react', label: 'React' },
  { slug: 'nextjs', label: 'Next.js' },
  { slug: 'vue', label: 'Vue.js' },
  { slug: 'angular', label: 'Angular' },
  { slug: 'svelte', label: 'Svelte' },
  { slug: 'nodejs', label: 'Node.js' },
  { slug: 'django', label: 'Django' },
  { slug: 'flask', label: 'Flask' },
  { slug: 'fastapi', label: 'FastAPI' },
  { slug: 'rails', label: 'Ruby on Rails' },
  { slug: 'spring', label: 'Spring' },
  { slug: 'dotnet', label: '.NET' },
  { slug: 'react-native', label: 'React Native' },
  { slug: 'flutter', label: 'Flutter' },
  { slug: 'graphql', label: 'GraphQL' },
  { slug: 'rest-api', label: 'REST APIs' },
  { slug: 'grpc', label: 'gRPC' },

  { slug: 'postgresql', label: 'PostgreSQL' },
  { slug: 'mysql', label: 'MySQL' },
  { slug: 'mongodb', label: 'MongoDB' },
  { slug: 'redis', label: 'Redis' },
  { slug: 'elasticsearch', label: 'Elasticsearch' },
  { slug: 'kafka', label: 'Apache Kafka' },
  { slug: 'spark', label: 'Apache Spark' },
  { slug: 'snowflake', label: 'Snowflake' },
  { slug: 'dbt', label: 'dbt' },
  { slug: 'airflow', label: 'Apache Airflow' },
  { slug: 'bigquery', label: 'BigQuery' },
  { slug: 'dynamodb', label: 'DynamoDB' },

  { slug: 'aws', label: 'AWS' },
  { slug: 'gcp', label: 'Google Cloud Platform' },
  { slug: 'azure', label: 'Microsoft Azure' },
  { slug: 'kubernetes', label: 'Kubernetes' },
  { slug: 'docker', label: 'Docker' },
  { slug: 'terraform', label: 'Terraform' },
  { slug: 'ansible', label: 'Ansible' },
  { slug: 'ci-cd', label: 'CI/CD' },
  { slug: 'linux', label: 'Linux' },
  { slug: 'git', label: 'Git' },
  { slug: 'microservices', label: 'Microservices' },

  { slug: 'pytorch', label: 'PyTorch' },
  { slug: 'tensorflow', label: 'TensorFlow' },
  { slug: 'scikit-learn', label: 'scikit-learn' },
  { slug: 'pandas', label: 'pandas' },
  { slug: 'llm', label: 'Large Language Models' },
  { slug: 'nlp', label: 'Natural Language Processing' },
];

/*
 * Skill aliases. Keys are folded, and matched against a TOKEN STREAM as
 * whole 1-, 2- or 3-token phrases - never as substrings.
 *
 * Substring matching is the single most common way a skill extractor
 * becomes a liar: "Java" inside "JavaScript", "R" inside "R&D", "Go"
 * inside "ongoing". Every one of those is a negative test in the spec
 * beside this file.
 */
export const SKILL_ALIASES: Readonly<Record<string, string>> = {
  typescript: 'typescript',
  ts: 'typescript',
  javascript: 'javascript',
  js: 'javascript',
  ecmascript: 'javascript',
  'vanilla javascript': 'javascript',
  python: 'python',
  python3: 'python',
  java: 'java',
  golang: 'golang',
  'go lang': 'golang',
  'go programming language': 'golang',
  rust: 'rust',
  ruby: 'ruby',
  php: 'php',
  'c#': 'csharp',
  csharp: 'csharp',
  'c sharp': 'csharp',
  'c++': 'cpp',
  cpp: 'cpp',
  'c plus plus': 'cpp',
  swift: 'swift',
  kotlin: 'kotlin',
  scala: 'scala',
  elixir: 'elixir',
  sql: 'sql',

  react: 'react',
  'react.js': 'react',
  reactjs: 'react',
  'next.js': 'nextjs',
  nextjs: 'nextjs',
  'vue.js': 'vue',
  vuejs: 'vue',
  vue: 'vue',
  angular: 'angular',
  angularjs: 'angular',
  svelte: 'svelte',
  sveltekit: 'svelte',
  'node.js': 'nodejs',
  nodejs: 'nodejs',
  node: 'nodejs',
  django: 'django',
  flask: 'flask',
  fastapi: 'fastapi',
  'ruby on rails': 'rails',
  rails: 'rails',
  'spring boot': 'spring',
  spring: 'spring',
  '.net': 'dotnet',
  dotnet: 'dotnet',
  '.net core': 'dotnet',
  'react native': 'react-native',
  'react-native': 'react-native',
  flutter: 'flutter',
  graphql: 'graphql',
  'rest api': 'rest-api',
  'rest apis': 'rest-api',
  restful: 'rest-api',
  'restful apis': 'rest-api',
  grpc: 'grpc',

  postgresql: 'postgresql',
  postgres: 'postgresql',
  'postgresql db': 'postgresql',
  psql: 'postgresql',
  mysql: 'mysql',
  mongodb: 'mongodb',
  mongo: 'mongodb',
  redis: 'redis',
  elasticsearch: 'elasticsearch',
  'elastic search': 'elasticsearch',
  kafka: 'kafka',
  'apache kafka': 'kafka',
  spark: 'spark',
  'apache spark': 'spark',
  pyspark: 'spark',
  snowflake: 'snowflake',
  dbt: 'dbt',
  airflow: 'airflow',
  'apache airflow': 'airflow',
  bigquery: 'bigquery',
  'big query': 'bigquery',
  dynamodb: 'dynamodb',

  aws: 'aws',
  'amazon web services': 'aws',
  gcp: 'gcp',
  'google cloud': 'gcp',
  'google cloud platform': 'gcp',
  azure: 'azure',
  'microsoft azure': 'azure',
  kubernetes: 'kubernetes',
  k8s: 'kubernetes',
  docker: 'docker',
  containerization: 'docker',
  terraform: 'terraform',
  ansible: 'ansible',
  'ci/cd': 'ci-cd',
  'ci cd': 'ci-cd',
  'continuous integration': 'ci-cd',
  'continuous delivery': 'ci-cd',
  linux: 'linux',
  unix: 'linux',
  git: 'git',
  microservices: 'microservices',
  'micro services': 'microservices',

  pytorch: 'pytorch',
  torch: 'pytorch',
  tensorflow: 'tensorflow',
  'scikit-learn': 'scikit-learn',
  'scikit learn': 'scikit-learn',
  sklearn: 'scikit-learn',
  pandas: 'pandas',
  llm: 'llm',
  llms: 'llm',
  'large language models': 'llm',
  nlp: 'nlp',
  'natural language processing': 'nlp',
};

/*
 * Terms deliberately NOT in the dictionary, and why.
 *
 * Each of these is a real skill whose common spelling is an ordinary
 * English word or a single letter. Token-anchored matching stops
 * "ongoing" matching "go", but it cannot stop "go" matching "go" in the
 * sentence "we want someone ready to go fast".
 *
 * The choice is between a false positive and a false negative, and they
 * are not symmetric. A false positive is asserted as a market fact, is
 * indistinguishable from a real one, and inflates a published prevalence.
 * A false negative is a gap that shows up in the unmapped-term backlog,
 * where it is measurable and fixable. So these are refused, and the
 * unambiguous spellings above ("golang", "go lang") are matched instead.
 *
 * This list exists so the refusal is a decision on the record rather than
 * an oversight, and there is a test asserting each of these stays unmapped.
 */
export const AMBIGUOUS_TERMS_REFUSED: readonly string[] = ['go', 'r', 'c'];

export const ROLE_BY_SLUG: ReadonlyMap<string, CanonicalTerm> = new Map(
  ROLES.map((role) => [role.slug, role]),
);

export const SKILL_BY_SLUG: ReadonlyMap<string, CanonicalTerm> = new Map(
  SKILLS.map((skill) => [skill.slug, skill]),
);
