/**
 * MSI CV Engine — GAS API wrapper (production-ready, async generation)
 *
 * GET  requests: action + params as URL query string.
 *   → CORS "simple request" — no preflight, works on all browsers + GitHub Pages.
 *
 * POST requests: Content-Type text/plain;charset=utf-8.
 *   → Also a "simple request" — no OPTIONS preflight, consistent across
 *     Chrome + Safari, compatible with GAS redirect behaviour.
 *   → GAS reads the body via e.postData.contents regardless of content-type.
 *
 * generateCV async flow:
 *   1. POST generateCV  → {jobId, status:"QUEUED"}   (returns in <1 s)
 *   2. Poll GET getJobStatus with exponential backoff (2 s → 5 s → 10 s → 15 s)
 *   3. Resolve when status:"DONE", reject on "FAILED" or timeout
 *
 * Job lifecycle: QUEUED → PROCESSING → WRITING_DOC → DONE | FAILED
 *
 * All methods catch + console.error before re-throwing so app.js try/catch
 * blocks can surface meaningful UI feedback without additional boilerplate.
 */

const API = (() => {

  // Exponential backoff schedule (ms) for polling. Caps at the last value.
  const POLL_BACKOFF_MS  = [2_000, 5_000, 10_000, 15_000];
  const MAX_POLL_MS      = 5 * 60_000; // give up after 5 minutes

  // ── Anonymous user identity ───────────────────────────────────────────────────

  function getUserId() {
    try {
      let id = localStorage.getItem(CONFIG.USER_ID_KEY);
      if (!id) {
        id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
        localStorage.setItem(CONFIG.USER_ID_KEY, id);
      }
      return id;
    } catch (_) {
      return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function parseResponse(resp) {
    const text = await resp.text();
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error(
        `Server returned non-JSON (HTTP ${resp.status}): ` + text.slice(0, 200)
      );
    }
  }

  // ── Transport: GET ────────────────────────────────────────────────────────────

  async function get(action, params = {}) {
    const url = new URL(CONFIG.GAS_URL);
    url.searchParams.set('action', action);
    url.searchParams.set('userId', getUserId());
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
    try {
      const resp = await fetch(url.toString(), { redirect: 'follow' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const data = await parseResponse(resp);
      if (data && data.error) throw new Error(data.error);
      return data;
    } catch (err) {
      console.error(`[API] GET ${action} failed:`, err);
      throw err;
    }
  }

  // ── Transport: POST ───────────────────────────────────────────────────────────

  async function post(action, payload) {
    const body = JSON.stringify({
      action,
      payload: Object.assign({}, payload, { userId: getUserId() }),
    });
    try {
      const resp = await fetch(CONFIG.GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body,
        redirect: 'follow',
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const data = await parseResponse(resp);
      if (data && data.error) throw new Error(data.error);
      return data;
    } catch (err) {
      console.error(`[API] POST ${action} failed:`, err);
      throw err;
    }
  }

  // ── Async job polling ─────────────────────────────────────────────────────────

  /**
   * Polls GET /getJobStatus until the job completes or the timeout is reached.
   *
   * @param {string}   jobId
   * @param {Function} [onProgress]  optional — called every poll with
   *                                 (elapsedMs: number, message: string)
   * @return {Promise<Object>}  the job's result object on success
   */
  async function pollUntilDone(jobId, onProgress) {
    const start = Date.now();
    let pollIndex = 0;

    while (true) {
      const delay = POLL_BACKOFF_MS[Math.min(pollIndex, POLL_BACKOFF_MS.length - 1)];
      pollIndex++;
      await sleep(delay);

      const elapsed = Date.now() - start;

      if (elapsed > MAX_POLL_MS) {
        throw new Error(
          'CV generation timed out after 5 minutes. ' +
          'The job may still be running — check your Google Drive.'
        );
      }

      let status;
      try {
        status = await get('getJobStatus', { jobId });
      } catch (pollErr) {
        console.error('[API] pollJobStatus network error (will retry):', pollErr);
        if (onProgress) onProgress(elapsed, 'Connection issue — retrying…');
        continue;
      }

      // Build a stage-aware progress message
      let msg;
      switch (status.status) {
        case 'QUEUED':
          msg = 'Waiting for server slot…';
          break;
        case 'PROCESSING':
          msg = elapsed < 90_000
            ? 'Generating CV…'
            : `Generating CV… (${Math.round(elapsed / 60_000)} min elapsed)`;
          break;
        case 'WRITING_DOC':
          msg = 'Finalizing document…';
          break;
        default:
          msg = elapsed < 30_000
            ? 'Generating CV… please wait'
            : `Still processing… (${Math.round(elapsed / 60_000)} min elapsed)`;
      }

      if (onProgress) onProgress(elapsed, msg);

      switch (status.status) {
        case 'DONE':
          return status.result;

        case 'FAILED':
          throw new Error(status.error || 'CV generation failed on the server');

        case 'NOT_FOUND':
          throw new Error('Job not found — it may have expired. Please try again.');

        case 'QUEUED':
        case 'PROCESSING':
        case 'WRITING_DOC':
          // Continue polling (backoff already applied above)
          break;

        default:
          console.warn('[API] Unexpected job status:', status.status);
      }
    }
  }

  // ── Public surface ────────────────────────────────────────────────────────────

  return {
    /**
     * Returns the sorted list of employee names from Drive.
     * @return {Promise<{employees: string[]}>}
     */
    getEmployees() {
      return get('getEmployees');
    },

    /**
     * Loads the full CV model for one employee.
     * @param {string} name
     * @return {Promise<Object>}
     */
    getEmployeeData(name) {
      return get('getEmployeeData', { name });
    },

    /**
     * Persists the current builder state as a draft in GAS Script Properties.
     * @param {Object} payload
     * @return {Promise<{success: boolean, savedAt: string}>}
     */
    saveCVData(payload) {
      return post('saveCVData', payload);
    },

    /**
     * Queues CV generation and polls until complete.
     *
     * The POST to /generateCV returns immediately (<1 s) with a jobId (status: QUEUED).
     * This method then polls /getJobStatus with exponential backoff (2 s → 5 s → 10 s → 15 s).
     * Total wait is typically 90–150 s (GAS trigger minimum + generation time).
     *
     * @param {Object}   payload     same shape as saveCVData
     * @param {Function} [onProgress]  optional callback(elapsedMs, message)
     *   — wire to showLoading() in app.js for live progress messages:
     *     API.generateCV(payload, (_, msg) => showLoading(msg))
     * @return {Promise<{docUrl: string, pdfUrl: string, docxUrl: string}>}
     */
    generateCV(payload, onProgress) {
      return post('generateCV', payload).then(async job => {
        if (!job.jobId) {
          throw new Error(job.error || 'Server did not return a job ID');
        }
        // Status can theoretically arrive as DONE if the backend ever switches
        // back to synchronous mode — handle it gracefully.
        if (job.status === 'DONE') return job.result;

        console.log('[API] generateCV job queued:', job.jobId);
        return pollUntilDone(job.jobId, onProgress);
      });
    },

    /**
     * Polls job status once (useful for debugging or manual retry).
     * @param {string} jobId
     * @return {Promise<{status: string, result?: Object, error?: string}>}
     */
    getJobStatus(jobId) {
      return get('getJobStatus', { jobId });
    },
  };

})();
