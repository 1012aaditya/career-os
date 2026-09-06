import * as DocumentPicker from 'expo-document-picker';
import {
  createResumeImport,
  type CreateResumeImportResponse,
} from './resume-import';
import { supabase } from '../lib/supabase';

export async function pickAndUploadResume(): Promise<CreateResumeImportResponse | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'application/pdf',
    copyToCacheDirectory: true,
    multiple: false,
  });

  if (result.canceled) {
    return null;
  }

  const file = result.assets[0];

  if (!file) {
    throw new Error('No resume file was selected');
  }

  if (!file.name.toLowerCase().endsWith('.pdf')) {
    throw new Error('Please select a PDF resume');
  }

  console.log('SELECTED RESUME:', {
    name: file.name,
    uri: file.uri,
    size: file.size,
    mimeType: file.mimeType,
  });

  const resumeImport = await createResumeImport(file.name);

  console.log('RESUME IMPORT CREATED:', {
    id: resumeImport.id,
    storagePath: resumeImport.storagePath,
    uploadPath: resumeImport.uploadPath,
  });

  const fileResponse = await fetch(file.uri);

  if (!fileResponse.ok) {
    throw new Error('Unable to read selected resume');
  }

  const blob = await fileResponse.blob();

  console.log('RESUME BLOB:', {
    size: blob.size,
    type: blob.type,
  });

  const pdfBlob = new Blob([blob], {
    type: 'application/pdf',
  });

  const { data: uploadData, error } = await supabase.storage
    .from('resumes')
    .uploadToSignedUrl(
      resumeImport.uploadPath,
      resumeImport.uploadToken,
      pdfBlob,
      {
        contentType: 'application/pdf',
        upsert: false,
      },
    );

  console.log('RESUME UPLOAD RESULT:', {
    uploadData,
    error,
    uploadPath: resumeImport.uploadPath,
    storagePath: resumeImport.storagePath,
  });

  if (error) {
    throw new Error(`Resume upload failed: ${error.message}`);
  }

  return resumeImport;
}
