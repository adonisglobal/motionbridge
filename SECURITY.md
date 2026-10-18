# Security policy

Motion2D is an experimental browser application. Security fixes are maintained on the latest development branch on a best-effort basis; earlier prototype versions do not have a separate support or backport commitment.

## Report a vulnerability

If the repository offers **Security > Report a vulnerability**, use that private reporting channel. If it is not available, open an issue asking the maintainer for a private contact method without including exploitation details or sensitive data. Private reporting availability depends on the repository configuration.

Include the affected version or commit, browser and operating system, reproduction steps, impact, and a minimal proof of concept when appropriate. Share only material you are authorized to disclose. Never include credentials, access tokens, personal videos, or private motion exports in a public report.

Please allow time for investigation and a fix before publishing detailed exploitation instructions. Response times are best effort; this prototype has no guaranteed security response schedule.

## Relevant behavior and boundaries

- Selected video and PNG files are decoded by the browser. The application does not implement a media-upload service.
- MediaPipe processes inputs on the device, but its package notice discloses performance and utilization metrics sent to Google. See the [README privacy information](README.md#privacy-and-network-behavior) and [third-party notices](THIRD_PARTY_NOTICES.md).
- Initial dependency installation and model setup access external services. Keep the lockfile and use the documented setup commands.
- Motion JSON includes the source filename and measured motion data. Review it before sharing it publicly.
- The session is held in browser memory, and there is currently no project-account or cloud-storage system.

For public hosting, use HTTPS, keep dependencies updated, preserve dependency notices, and review the behavior of any added hosting or analytics service. Report tracking inaccuracies, unsupported codecs, and ordinary visual defects through the normal bug-report process unless they also create a security impact.
