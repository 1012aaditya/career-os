import { useCallback, useEffect, useState } from 'react';

import { describeError } from '../api/client';
import {
  EMPTY_EVIDENCE,
  fetchEvidence,
  type EvidenceList,
} from './evidence-api';

/*
 * Loading a user's evidence.
 *
 * The one behaviour worth naming: a failed refresh does NOT discard what is
 * already on screen. Replacing a list of real evidence with an error page
 * because one request timed out loses information the user already had, and
 * on this screen in particular it reads as "your evidence is gone".
 */
export function useEvidence() {
  const [data, setData] = useState<EvidenceList>(EMPTY_EVIDENCE);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      setData(await fetchEvidence());
      setLoaded(true);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    data,
    /** True once a response has been received at least once. */
    loaded,
    loading,
    /*
     * An error is surfaced only when there is nothing to show. With data
     * already loaded, a failed refresh leaves the list in place - the
     * screens show a quiet retry instead of an error page.
     */
    error: loaded ? null : error,
    refreshError: error,
    reload: load,
  };
}
