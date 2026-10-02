# 1.5.3 HOTFIX

The 1.5.2 control plane could authenticate through GitHub but fail to persist the resulting admin session because the OAuth callback combined two `Set-Cookie` values into a single header.

1.5.3 sends them as separate `Set-Cookie` headers and explicitly uses same-origin credentials for admin API fetches.
