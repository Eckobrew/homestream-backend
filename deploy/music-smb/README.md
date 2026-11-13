# HomeStream Music over SMB

This optional service presents `Music/<profile>/<artist>/<album>/<track>` on the HomeStream host.
It reads the existing music mount and SQLite database, and keeps only a short-lived directory index in memory.
Guests can browse all opted-in profile folders. The share is read-only.

Set the four environment variables in the Compose file. The SMB config directory must contain `accounts.json`,
readable by UID 1001 and protected from other users. Add an entry to opt a profile in. Username is the folder name:

```json
[{"ProfileID":"homestream-profile-id","Username":"mirelle"}]
```

Keep the profile list outside source control.
Start with `docker compose --profile music-smb up -d --build` from this directory.
Connect to `smb://<HomeStream LAN IP>/Music` as Guest. Keep TCP 445 on the trusted LAN.
Do not forward it to the internet.

Remove an entry to opt out. Replace the file atomically so active requests never see a partially written file.
Existing open files can finish reading. Collection membership updates appear on new directory opens after up to
15 seconds plus any directory caching by the SMB client. Stop the sidecar to disable the whole feature.

For Finder Network discovery on a Linux host with Avahi, install
`homestream-music.service` in `/etc/avahi/services/` while the SMB sidecar is enabled.
Publish it only on the LAN interface that serves TCP 445. Remove the service file
when disabling the sidecar. Finder lists the server as **HomeStream**, with
**Music** inside it after connecting as Guest.
