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

export const RULESET_VERSION = 6;

/*
 * v6 is where the v5 correction actually took effect. The v5 edit was
 * written but silently failed to apply - the file had been reformatted, so
 * the text being replaced no longer existed - and v5 therefore re-ran v4's
 * logic under a new number. Caught because v4 and v5 produced byte-identical
 * match-method counts, which a real change could not have.
 *
 * v5 intended to correct v4's matching order. v4 tried the publisher's code BEFORE
 * the title, and the corpus showed that was wrong: it changed 181
 * already-correct mappings, every one a loss of specificity, because an
 * occupational code is a coarser claim than a title by design. v5 tries
 * the title first and falls back to the code, which keeps the resolution
 * gain and the precision.
 *
 * v4 added occupational-code matching, and the reason is a measurement.
 * v3's Unicode fix moved role resolution by exactly zero, because
 * resolution matched titles against 159 hand-authored aliases of which
 * none contained a non-ASCII character. The bottleneck was never the
 * tokenizer; it was that we were reading the title and ignoring the
 * classification the publisher had already attached to the posting.
 *
 * v4 reads the code first. It is language-independent, asserted by the
 * publisher rather than inferred by us, and one code covers thousands of
 * postings where an alias covers one spelling.
 *
 * v3 made the tokenizer Unicode-aware. TOKEN_CHARS was ASCII-only, so
 * every non-Latin-alphabet character was a word boundary and every
 * accented or non-English title fragmented: "Mjukvaruingenjor" (with an
 * o-umlaut) became "mjukvaruingenj" + "r". The version moves because the
 * same stored posting now normalizes differently - which is exactly what a
 * ruleset version is for. v1 and v2 normalizations are retained, not
 * rewritten, so published signals keep meaning what they meant.
 *
 * v2 changed how titles and employer names are read. Every change is a
 * correction, and every one alters what already-ingested postings are
 * understood to say - so the version moves with them. A published number
 * keeps meaning what it meant because it is stamped with the rules that
 * produced it, and v1 normalizations are retained rather than rewritten.
 *
 *   - level words are stripped from the FRONT of a title only. Matching
 *     the tail deleted the job word from 168 real titles ("Art Director"
 *     became "art") and resolved a role in exactly one of them.
 *   - the strip repeats, so "Sr. Staff Software Engineer" loses both.
 *   - a strip that would leave a dangling preposition is refused, so
 *     "Director of Product Management" stays whole instead of becoming
 *     "of product management".
 *   - employer folding loops to a fixed point and refuses any removal that
 *     would not leave a name, so "The Limited" no longer folds to "the".
 *   - "director of engineering" no longer resolves to engineering-manager;
 *     a director and an engineering manager are not one role.
 */

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
/**
 * Canonical roles introduced by VOCABULARY_VERSION 1.
 *
 * Authored from the occupational labels the publishers themselves use, so
 * every one is checkable against a public classification. They exist
 * because the corpus is a general labour market and the vocabulary was
 * not: cooks, drivers, carers and retail staff are 96% of what is
 * actually stored, and no amount of tech vocabulary reaches them.
 */
export const VOCABULARY_V1_ROLES: ReadonlyArray<readonly [string, string]> = [
  ['cook', 'Cook'],
  ['chef', 'Chef'],
  ['food-service-worker', 'Food Service Worker'],
  ['food-and-beverage-server', 'Food and Beverage Server'],
  ['food-service-supervisor', 'Food Service Supervisor'],
  ['restaurant-manager', 'Restaurant Manager'],
  ['retail-salesperson', 'Retail Salesperson'],
  ['retail-sales-supervisor', 'Retail Sales Supervisor'],
  ['retail-manager', 'Retail Manager'],
  ['cashier', 'Cashier'],
  ['truck-driver', 'Truck Driver'],
  ['delivery-driver', 'Delivery Driver'],
  ['child-care-provider', 'Child Care Provider'],
  ['early-childhood-educator', 'Early Childhood Educator'],
  ['home-support-worker', 'Home Support Worker'],
  ['nurse-aide', 'Nurse Aide'],
  ['licensed-practical-nurse', 'Licensed Practical Nurse'],
  ['farm-worker', 'Farm Worker'],
  ['cleaner', 'Cleaner'],
  ['receptionist', 'Receptionist'],
  ['administrative-assistant', 'Administrative Assistant'],
  ['administrative-officer', 'Administrative Officer'],
  ['construction-labourer', 'Construction Labourer'],
  ['automotive-technician', 'Automotive Technician'],
  ['carpenter', 'Carpenter'],
  ['welder', 'Welder'],
  ['electrician', 'Electrician'],
  ['material-handler', 'Material Handler'],
  ['storekeeper', 'Storekeeper'],
  ['customer-service-representative', 'Customer Service Representative'],
  ['security-guard', 'Security Guard'],
  ['hairstylist', 'Hairstylist'],
  ['bookkeeper', 'Bookkeeper'],
  ['accounting-clerk', 'Accounting Clerk'],
  ['accountant', 'Accountant'],
  ['social-services-worker', 'Social Services Worker'],
  ['teacher', 'Teacher'],
  ['teaching-assistant', 'Teaching Assistant'],
  ['head-teacher', 'Head Teacher'],
  ['marketing-specialist', 'Marketing Specialist'],
  ['systems-analyst', 'Systems Analyst'],
  ['it-specialist', 'IT Specialist'],
  ['it-support', 'IT Support'],
  ['systems-administrator', 'Systems Administrator'],
  ['computer-scientist', 'Computer Scientist'],
  ['management-analyst', 'Management Analyst'],
  ['financial-specialist', 'Financial Specialist'],
  ['human-resources-specialist', 'Human Resources Specialist'],
  ['electrical-engineer', 'Electrical Engineer'],
];

export const TECH_ROLES: readonly CanonicalTerm[] = [
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
  /*
   * Added in v2 from the measured backlog: 45 and 31 real postings
   * respectively, and neither fits an existing role. A technical program
   * manager is not a product manager and not an engineering manager; a
   * research engineer is not a machine-learning engineer. Mapping either
   * to a neighbour would be a guess with a slug attached.
   */
  { slug: 'technical-program-manager', label: 'Technical Program Manager' },
  { slug: 'research-engineer', label: 'Research Engineer' },
];

/**
 * Every canonical role: the original tech vocabulary plus the occupational
 * families VOCABULARY_VERSION 1 added.
 *
 * They are concatenated rather than merged into one literal so the two
 * origins stay visible - the tech roles were authored from observed
 * postings, the rest from published occupational classifications - and so
 * a reviewer can see at a glance which set a slug came from.
 */
export const ROLES: readonly CanonicalTerm[] = [
  ...TECH_ROLES,
  ...VOCABULARY_V1_ROLES.map(([slug, label]) => ({ slug, label })),
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
  'member of the technical staff': 'software-engineer',
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
  /*
   * 'director of engineering' was here and was removed in v2. It asserted
   * that a director and an engineering manager are one role - a level
   * collapse, and exactly the kind of guess the no-fuzzy-fallback rule
   * exists to prevent. It resolved 6 postings into an 83-posting bucket.
   * Leadership titles now stay in the visible backlog, where a person can
   * decide whether they are countable.
   */

  'product manager': 'product-manager',
  'technical product manager': 'product-manager',
  'group product manager': 'product-manager',

  'technical program manager': 'technical-program-manager',
  'technical program management': 'technical-program-manager',
  'program manager technical': 'technical-program-manager',

  'research engineer': 'research-engineer',

  'product designer': 'product-designer',
  'ux designer': 'product-designer',
  'ui designer': 'product-designer',
  'ui/ux designer': 'product-designer',

  'solutions engineer': 'solutions-engineer',
  'sales engineer': 'solutions-engineer',
  'solutions architect': 'solutions-engineer',
  'delivery solutions architect': 'solutions-engineer',
  'specialist solutions architect': 'solutions-engineer',
  'partner solutions architect': 'solutions-engineer',
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
  'sr. staff',
  'sr staff',
  'entry level',
  'early career',
  'new grad',
  'principal',
  'associate',
  'director',
  'lead',
  'senior',
  /*
   * One employer's house style for an existing level, on 45 real postings.
   * Must precede 'staff' or the plus is left stranded on the title.
   */
  'staff+',
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

/**
 * The version of the CANONICAL VOCABULARY, separate from RULESET_VERSION.
 *
 * The ruleset is how text is read; the vocabulary is what it may resolve
 * to. They change for different reasons and at different rates - adding a
 * role does not alter how a title is tokenized - so conflating them would
 * force a full re-normalization for every vocabulary edit. Both are
 * stamped on the normalization row, so a resolved role is always
 * attributable to the exact rules and the exact vocabulary that produced
 * it.
 */
export const VOCABULARY_VERSION = 1;

/**
 * Occupational classifications, keyed by SCHEME then by code.
 *
 * The evidence layer for the whole phase. Every value here is the
 * publisher's own code paired with a canonical role we authored, and the
 * official label is kept in the comment so a reviewer can check the
 * mapping without a lookup.
 *
 * Three rules govern what may go in:
 *
 *   1. Only where the publisher's own label makes the mapping obvious. A
 *      code whose label spans several distinct occupations is left out
 *      rather than flattened.
 *   2. Never a merge across a real boundary. "Restaurant and food service
 *      managers" is not "Food service supervisors"; "Chefs" is not
 *      "Cooks"; an analyst is not a scientist. Each keeps its own role.
 *   3. External codes are EVIDENCE, not identity. The canonical role slug
 *      is ours; the NOC or OPM code is a reference recorded beside it.
 */
export const OCCUPATION_ROLES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  /* NOC 2021 five-digit unit groups, with NOC 2016 four-digit forms where
   * the corpus still carries them. Codes are strings: leading zeros are
   * significant. */
  noc: {
    '63200': 'cook',
    '62200': 'chef',
    '65201': 'food-service-worker',
    '6513': 'food-and-beverage-server',
    '62020': 'food-service-supervisor',
    '0631': 'restaurant-manager',
    '60030': 'restaurant-manager',
    '64100': 'retail-salesperson',
    '62010': 'retail-sales-supervisor',
    '0621': 'retail-manager',
    '65100': 'cashier',
    '73300': 'truck-driver',
    '7514': 'delivery-driver',
    '44100': 'child-care-provider',
    '4214': 'early-childhood-educator',
    '44101': 'home-support-worker',
    '33102': 'nurse-aide',
    '32101': 'licensed-practical-nurse',
    '8431': 'farm-worker',
    '65310': 'cleaner',
    '14101': 'receptionist',
    '1241': 'administrative-assistant',
    '1221': 'administrative-officer',
    '75110': 'construction-labourer',
    '72410': 'automotive-technician',
    '72310': 'carpenter',
    '72106': 'welder',
    '72200': 'electrician',
    '7452': 'material-handler',
    '14401': 'storekeeper',
    '64409': 'customer-service-representative',
    '64410': 'security-guard',
    '63210': 'hairstylist',
    '12200': 'bookkeeper',
    '14200': 'accounting-clerk',
    '11100': 'accountant',
    '4212': 'social-services-worker',
    '43100': 'teaching-assistant',
    '11202': 'marketing-specialist',
    /* Information systems analysts and consultants. A distinct
     * occupation from software-engineer in NOC's own structure, and kept
     * distinct here rather than folded into it. */
    '21222': 'systems-analyst',
  },

  /*
   * US OPM occupational series. 2210 is "Information Technology
   * Management" and covers 9,959 unresolved federal postings whose titles
   * are literally "IT Specialist".
   *
   * Deliberately NOT mapped to software-engineer. The series spans
   * administration, security, network and applications work, and folding
   * it into a software-engineering role would be exactly the false merge
   * this vocabulary is built to avoid. It gets a role that says what the
   * series says.
   */
  'opm-series': {
    '2210': 'it-specialist',
    '1550': 'computer-scientist',
    '0343': 'management-analyst',
    '0501': 'financial-specialist',
    '0201': 'human-resources-specialist',
  },

  /* The DfE publishes a small closed enum rather than codes. */
  'dfe-occupational-category': {
    teacher: 'teacher',
    teaching_assistant: 'teaching-assistant',
    higher_level_teaching_assistant: 'teaching-assistant',
    headteacher: 'head-teacher',
    deputy_headteacher: 'head-teacher',
    it_support: 'it-support',
    administration_hr_data_and_finance: 'administrative-assistant',
  },

  /*
   * JobTech publishes Swedish occupation LABELS, not codes. They are
   * treated as codes because that is what they are here: a controlled
   * vocabulary the publisher assigns, not free text a candidate wrote.
   * This is how Swedish postings resolve without a Swedish alias list.
   */
  'ssyk-label': {
    'Systemutvecklare/Programmerare': 'software-engineer',
    'Mjukvaru- och systemutvecklare m.fl.': 'software-engineer',
    'Nätverks- och systemtekniker m.fl.': 'systems-administrator',
    'Supporttekniker, IT': 'it-support',
    'Systemanalytiker och IT-arkitekter m.fl.': 'systems-analyst',
    'Drifttekniker, IT': 'systems-administrator',
    'Testledare och testare': 'qa-engineer',
    'Civilingenjörsyrken inom elektroteknik': 'electrical-engineer',
  },
};
