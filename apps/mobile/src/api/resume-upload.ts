import * as DocumentPicker from 'expo-document-picker';

import {
  createResumeImport,
  type CreateResumeImportResponse,
} from './resume-import';

import { supabase } from '../lib/supabase';

export async function pickAndUploadResume(): Promise<
  CreateResumeImportResponse | null
> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'application/pdf',
    copyToCacheDirectory: true,
    multiple: false,
  });

  if (result.canceled) {
    return null;
  }

  const file = result.assets[0];

  if (file.mimeType !== 'application/pdf') {
    throw new Error('Please select a PDF resume');
  }

  const resumeImport = await createResumeImport(file.name);

  const fileResponse = await fetch(file.uri);

  if (!fileResponse.ok) {
    throw new Error('Unable to read selected resume');
  }

  const blob = await fileResponse.blob();

  const { error } = await supabase.storage
    .from('resumes')
    .uploadToSignedUrl(
      resumeImport.uploadPath,
      resumeImport.uploadToken,
      blob,
      {
        contentType: 'application/pdf',
        upsert: false,
      },
    );

  if (error) {
    throw new Error(`Resume upload failed: ${error.message}`);
  }

  return resumeImport;
}
