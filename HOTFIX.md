# AskMoina 1.2.1 Hotfix

This package fixes a frontend JavaScript initialization issue that prevented composer, history, suggestions, and other controls from binding. The missing client-side UI/helper functions have been restored.

The HTML script reference includes a cache-busting query string so the corrected app.js is fetched after deployment.
