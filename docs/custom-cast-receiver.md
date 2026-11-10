# HomeStream Cast receiver

Fresh Android and web builds use Google's Default Media Receiver. Basic casting requires no receiver registration or hosted receiver files.

Custom receivers are opt-in. Pass `-PcastReceiverAppId=YOUR_APP_ID` to the Android build and set `NEXT_PUBLIC_CAST_RECEIVER_APP_ID=YOUR_APP_ID` when building the web app. For Docker, pass it as a build argument. Both overrides must name the same Cast registration. Keep these settings in deployment configuration. An opt-in build uses its configured receiver, so a registration or hosting error needs to be fixed in that deployment.

Host the receiver HTML, CSS and JavaScript in a private source directory outside the Git repositories. Mount the assets read-only at `/app/public/cast` in the web container or serve them at `/cast/` through the reverse proxy. The private directory and its backup must be provided separately from the application images. Receiver assets are excluded from the web Docker build and Git tracking.

Register the deployment's HTTPS `/cast/receiver.html` URL in the Google Cast Developer Console for a published receiver. For development, register the hardware and configure the test URL in the console.

When configured for a custom receiver, both senders request video capabilities on `urn:x-cast:uk.eckonet.homestream`. The request has type `capabilities-request` and a request ID. The receiver replies to that sender with type `capabilities`, the same request ID, and a `video` array of codec, width, height and profiles. Use CAF's `canDisplayType` to probe the receiver and connected display. Unavailable or unsupported probes fall back to a conservative sender profile. Network performance and audio output still need hardware verification.

The receiver also accepts `{type:"idle",items:[{title,artwork}]}` from Android. Keep standby artwork separate from playable media. Do not log media URLs, resource tickets, sender tokens, or raw receiver payloads. Cast playback and subtitle URLs returned by the API are scoped resource tickets.

Verify a fresh load, Continue, reconnect while paused, seek, subtitle selection, episode autoplay, stop, and a Kids profile switch. Run the checks on Chromecast Ultra and Chromecast with Google TV HD. Check that the receiver remains idle after a profile switch and that the previous profile's media ticket is rejected.
