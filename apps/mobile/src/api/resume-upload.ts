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


  /*
   * Four console.log calls used to sit along this path, printing the
   * file name, the local file URI, the storage path and the full upload
   * result. Between them that is the user's own name - resumes are
   * usually named after their author - their user id, and the location of
   * the file on their device, written to the device console on every
   * upload. There is no babel transform stripping console calls from
   * release builds, so they shipped.
   *
   * Removed rather than guarded. PR-5 owns real logging; until it exists
   * the honest amount of logging on a path that handles a resume is none.
   */
  const resumeImport = await createResumeImport(file.name);


  const fileResponse = await fetch(file.uri);

  if (!fileResponse.ok) {
    throw new Error('Unable to read selected resume');
  }

  const blob = await fileResponse.blob();


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


  if (error) {
    throw new Error(`Resume upload failed: ${error.message}`);
  }

  return resumeImport;
}
