const CONFIG = {
  // Deployed GAS Web App URL — only place this lives in the entire frontend.
  GAS_URL: 'https://script.google.com/macros/s/AKfycbwFqKu2ZBq2Z12B9gy9a_CGt-ota7DUOrEWF__SbHmANywAx40tEQvU7vIyeyPI4SK5/exec',

  // localStorage key under which the stable anonymous userId is stored.
  USER_ID_KEY: 'msi_cv_uid',

  // Auto-save debounce for localStorage draft (ms). 0 = disabled.
  AUTO_SAVE_INTERVAL_MS: 3000,

  // localStorage key prefix for per-employee drafts.
  DRAFT_KEY_PREFIX: 'msi_cv_draft_',
};
