# BeatPass Blog

Infrastructure, automation scripts, and configuration for the BeatPass blog — powered by [Ghost CMS](https://ghost.org).

**https://blog.beatpass.ca**

---

## Overview

This repository contains the server-side tooling that powers the BeatPass blog, including content deployment pipelines, scheduling automation, YouTube-to-blog synchronization, and SEO configuration.

### Repository Structure

```
.
├── scripts/               # Automation and deployment scripts
│   ├── deploy-content.js  # Bulk content deployment to Ghost
│   ├── schedule-drafts.js # Intelligent post scheduling
│   ├── youtube-sync.js    # YouTube → Ghost video sync pipeline
│   ├── video-api.js       # Video export API server
│   └── load-env.js        # Environment variable loader
├── .env.example           # Environment variable template
├── robots.txt             # Search engine configuration
├── start.js               # Ghost CMS entry point
└── package.json           # Project metadata
```

## Setup

1. Clone the repository into your Ghost installation directory.
2. Copy `.env.example` to `.env` and fill in your credentials.
3. Install script dependencies:
   ```bash
   cd scripts && npm install
   ```
4. Configure Ghost as normal via `ghost-cli`.

## Related

- **[BeatPass Content Designer](https://github.com/alliancewav/BeatPass-ContentDesigner)** — Slide and visual content generation tool for blog articles.
- **[BeatPass](https://beatpass.ca)** — The beat licensing platform.

---

## License

This is proprietary software. All rights reserved by **Alliance Productions Records Inc.**

No part of this repository may be copied, modified, distributed, or reused in any form without explicit written permission. See [LICENSE](./LICENSE) for full terms.

## Contact

Alliance Productions Records Inc.
Email: contact.alliancewav@gmail.com
