import React, { useEffect, useState } from 'react';

/*
 * Errors are routed through describeError rather than rendered from a
 * caught value. Anything that is not an ApiError is a bug in our own
 * code, and its message is an internal string that should not appear in
 * an Alert in front of a user.
 */
import { describeError } from '../api/client';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { getResumeImport } from '../api/resume-import';
import {
  confirmResumeImport,
  updateResumeImport,
} from '../api/resume-import';


type Basics = {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  github?: string | null;
  linkedin?: string | null;
  portfolio?: string | null;
};

type Education = {
  institution: string;
  location?: string | null;
  degree?: string | null;
  field_of_study?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  grade?: string | null;
  relevant_courses?: string[];
};

type Project = {
  name: string;
  description?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  technologies?: string[];
};

type Experience = {
  company: string;
  role?: string | null;
  location?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  description?: string | null;
  technologies?: string[];
};

type Achievement = {
  title: string;
  description?: string | null;
  date?: string | null;
};

type Extraction = {
  basics: Basics;
  education: Education[];
  skills: string[];
  projects: Project[];
  experience: Experience[];
  achievements: Achievement[];
  additional_information: string[];
};


type ResumeImport = {
  id: string;
  fileName: string;
  status: string;
  extractionResult?: {
    source?: string;
    extraction?: Extraction;
  } | null;
};


type Props = {
  route: {
    params: {
      resumeImportId: string;
    };
  };
  navigation: {
    goBack: () => void;
  };
};


export default function ResumeReviewScreen({
  route,
  navigation,
}: Props) {
  const { resumeImportId } = route.params;

  const [resumeImport, setResumeImport] =
    useState<ResumeImport | null>(null);

  const [extraction, setExtraction] =
    useState<Extraction | null>(null);

  const [loading, setLoading] =
    useState(true);

  const [saving, setSaving] =
    useState(false);

  useEffect(() => {
    loadResume();
  }, []);

  async function loadResume() {
    try {
      const data = await getResumeImport(
        resumeImportId,
      );

      setResumeImport(data);

      setExtraction(
        data.extractionResult?.extraction ?? null,
      );
    } catch (error) {
      Alert.alert(
        'Unable to load resume',
        describeError(error),
      );
    } finally {
      setLoading(false);
    }
  }

  function updateBasics(
    field: keyof Basics,
    value: string,
  ) {
    if (!extraction) return;

    setExtraction({
      ...extraction,
      basics: {
        ...extraction.basics,
        [field]: value,
      },
    });
  }

  function updateSkill(
    index: number,
    value: string,
  ) {
    if (!extraction) return;

    const skills = [...extraction.skills];

    skills[index] = value;

    setExtraction({
      ...extraction,
      skills,
    });
  }

  function updateProject(
    index: number,
    field: keyof Project,
    value: string,
  ) {
    if (!extraction) return;

    const projects = [...extraction.projects];

    projects[index] = {
      ...projects[index],
      [field]: value,
    };

    setExtraction({
      ...extraction,
      projects,
    });
  }

  async function handleSave() {
    if (!extraction) return;

    try {
      setSaving(true);

      const updated =
        await updateResumeImport(
          resumeImportId,
          {
            source: 'resume_pdf',
            extraction,
          },
        );

      setResumeImport(updated);

      Alert.alert(
        'Saved',
        'Your resume changes were saved.',
      );
    } catch (error) {
      Alert.alert(
        'Unable to save',
        describeError(error),
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirm() {
    if (!extraction) return;

    Alert.alert(
      'Confirm resume',
      'Are you sure you want to confirm this information?',
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Confirm',
          onPress: async () => {
            try {
              setSaving(true);

              await updateResumeImport(
                resumeImportId,
                {
                  source: 'resume_pdf',
                  extraction,
                },
              );

              await confirmResumeImport(
                resumeImportId,
              );

              Alert.alert(
                'Resume confirmed',
                'Your resume information is ready for your Career Graph.',
                [
                  {
                    text: 'Done',
                    onPress: () =>
                      navigation.goBack(),
                  },
                ],
              );
            } catch (error) {
              Alert.alert(
                'Unable to confirm',
                describeError(error),
              );
            } finally {
              setSaving(false);
            }
          },
        },
      ],
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
        <Text style={styles.loadingText}>
          Loading resume...
        </Text>
      </View>
    );
  }

  if (!resumeImport || !extraction) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>
          Resume extraction is not available.
        </Text>

        <Pressable
          style={styles.button}
          onPress={navigation.goBack}
        >
          <Text style={styles.buttonText}>
            Go Back
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.container}
    >
      <Text style={styles.title}>
        Review your resume
      </Text>

      <Text style={styles.subtitle}>
        Check the extracted information and fix
        anything that is incorrect.
      </Text>

      <Section title="Personal information">
        <Field
          label="Name"
          value={extraction.basics.name ?? ''}
          onChangeText={(value) =>
            updateBasics('name', value)
          }
        />

        <Field
          label="Email"
          value={extraction.basics.email ?? ''}
          onChangeText={(value) =>
            updateBasics('email', value)
          }
        />

        <Field
          label="Phone"
          value={extraction.basics.phone ?? ''}
          onChangeText={(value) =>
            updateBasics('phone', value)
          }
        />

        <Field
          label="GitHub"
          value={extraction.basics.github ?? ''}
          onChangeText={(value) =>
            updateBasics('github', value)
          }
        />

        <Field
          label="LinkedIn"
          value={extraction.basics.linkedin ?? ''}
          onChangeText={(value) =>
            updateBasics('linkedin', value)
          }
        />

        <Field
          label="Portfolio"
          value={extraction.basics.portfolio ?? ''}
          onChangeText={(value) =>
            updateBasics('portfolio', value)
          }
        />
      </Section>

      <Section title="Education">
        {extraction.education.map(
          (education, index) => (
            <View
              key={`${education.institution}-${index}`}
              style={styles.card}
            >
              <Text style={styles.cardTitle}>
                {education.institution}
              </Text>

              <Text style={styles.cardText}>
                {education.degree ?? ''}
              </Text>

              {education.location && (
                <Text style={styles.cardText}>
                  {education.location}
                </Text>
              )}

              {education.grade && (
                <Text style={styles.cardText}>
                  Grade: {education.grade}
                </Text>
              )}

              {education.start_date && (
                <Text style={styles.cardText}>
                  {education.start_date}
                  {education.end_date
                    ? ` – ${education.end_date}`
                    : ''}
                </Text>
              )}
            </View>
          ),
        )}
      </Section>

      <Section title="Skills">
        {extraction.skills.map(
          (skill, index) => (
            <Field
              key={`${skill}-${index}`}
              label={`Skill ${index + 1}`}
              value={skill}
              onChangeText={(value) =>
                updateSkill(index, value)
              }
            />
          ),
        )}
      </Section>

      <Section title="Projects">
        {extraction.projects.map(
          (project, index) => (
            <View
              key={`${project.name}-${index}`}
              style={styles.card}
            >
              <Field
                label="Project name"
                value={project.name}
                onChangeText={(value) =>
                  updateProject(
                    index,
                    'name',
                    value,
                  )
                }
              />

              <Field
                label="Description"
                value={
                  project.description ?? ''
                }
                multiline
                onChangeText={(value) =>
                  updateProject(
                    index,
                    'description',
                    value,
                  )
                }
              />

              <Field
                label="Start date"
                value={
                  project.start_date ?? ''
                }
                onChangeText={(value) =>
                  updateProject(
                    index,
                    'start_date',
                    value,
                  )
                }
              />

              <Field
                label="End date"
                value={
                  project.end_date ?? ''
                }
                onChangeText={(value) =>
                  updateProject(
                    index,
                    'end_date',
                    value,
                  )
                }
              />

              <Text style={styles.label}>
                Technologies
              </Text>

              <Text style={styles.cardText}>
                {project.technologies?.join(', ') ||
                  'None'}
              </Text>
            </View>
          ),
        )}
      </Section>

      <Section title="Experience">
        {extraction.experience.length === 0 ? (
          <Text style={styles.emptyText}>
            No experience found.
          </Text>
        ) : (
          extraction.experience.map(
            (experience, index) => (
              <View
                key={`${experience.company}-${index}`}
                style={styles.card}
              >
                <Text style={styles.cardTitle}>
                  {experience.company}
                </Text>

                <Text style={styles.cardText}>
                  {experience.role ?? ''}
                </Text>

                <Text style={styles.cardText}>
                  {experience.description ?? ''}
                </Text>
              </View>
            ),
          )
        )}
      </Section>

      <Section title="Achievements">
        {extraction.achievements.length === 0 ? (
          <Text style={styles.emptyText}>
            No achievements found.
          </Text>
        ) : (
          extraction.achievements.map(
            (achievement, index) => (
              <View
                key={`${achievement.title}-${index}`}
                style={styles.card}
              >
                <Text style={styles.cardTitle}>
                  {achievement.title}
                </Text>

                {achievement.description && (
                  <Text style={styles.cardText}>
                    {achievement.description}
                  </Text>
                )}
              </View>
            ),
          )
        )}
      </Section>

      <Section title="Additional information">
        {extraction.additional_information.length ===
        0 ? (
          <Text style={styles.emptyText}>
            No additional information found.
          </Text>
        ) : (
          extraction.additional_information.map(
            (item, index) => (
              <Text
                key={`${item}-${index}`}
                style={styles.cardText}
              >
                • {item}
              </Text>
            ),
          )
        )}
      </Section>

      <Pressable
        style={[
          styles.button,
          saving && styles.buttonDisabled,
        ]}
        disabled={saving}
        onPress={handleSave}
      >
        <Text style={styles.buttonText}>
          {saving
            ? 'Saving...'
            : 'Save changes'}
        </Text>
      </Pressable>

      <Pressable
        style={[
          styles.confirmButton,
          saving && styles.buttonDisabled,
        ]}
        disabled={saving}
        onPress={handleConfirm}
      >
        <Text style={styles.buttonText}>
          Confirm resume
        </Text>
      </Pressable>
    </ScrollView>
  );
}


function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>
        {title}
      </Text>

      {children}
    </View>
  );
}


function Field({
  label,
  value,
  onChangeText,
  multiline = false,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  multiline?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>
        {label}
      </Text>

      <TextInput
        value={value}
        onChangeText={onChangeText}
        multiline={multiline}
        style={[
          styles.input,
          multiline && styles.multilineInput,
        ]}
      />
    </View>
  );
}


const styles = StyleSheet.create({
  container: {
    padding: 20,
    paddingBottom: 40,
  },

  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },

  loadingText: {
    marginTop: 10,
  },

  errorText: {
    marginBottom: 20,
  },

  title: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 8,
  },

  subtitle: {
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 24,
  },

  section: {
    marginBottom: 28,
  },

  sectionTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 14,
  },

  field: {
    marginBottom: 14,
  },

  label: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
  },

  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },

  multilineInput: {
    minHeight: 100,
    textAlignVertical: 'top',
  },

  card: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },

  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 6,
  },

  cardText: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 4,
  },

  emptyText: {
    fontSize: 14,
  },

  button: {
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 8,
    borderWidth: 1,
  },

  confirmButton: {
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 12,
    marginBottom: 20,
  },

  buttonDisabled: {
    opacity: 0.5,
  },

  buttonText: {
    fontSize: 16,
    fontWeight: '700',
  },
});
