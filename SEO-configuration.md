# SEO Configuration for blog.beatpass.ca

This document outlines the SEO configuration needed on the BeatPass blog to establish proper domain hierarchy with the parent domain `beatpass.ca`.

---

## 1. Update robots.txt

Create or update `/robots.txt` on blog.beatpass.ca:

```txt
# robots.txt for blog.beatpass.ca
# Last updated: December 2025

User-agent: *
Allow: /

# Disallow admin/private areas
Disallow: /admin/
Disallow: /wp-admin/
Disallow: /ghost/
Disallow: /*?preview=*

# Allow assets
Allow: /assets/
Allow: /content/
Allow: /*.css
Allow: /*.js
Allow: /*.jpg
Allow: /*.png
Allow: /*.svg
Allow: /*.webp

# Crawl delay
Crawl-delay: 1

# Sitemap location
Sitemap: https://blog.beatpass.ca/sitemap.xml

# Host directive (subdomain of beatpass.ca)
Host: https://blog.beatpass.ca
```

---

## 2. Add Blog Schema with isPartOf (JSON-LD)

Add this structured data to the blog's `<head>` section (or theme header):

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Blog",
  "@id": "https://blog.beatpass.ca/#blog",
  "name": "BeatPass Blog",
  "url": "https://blog.beatpass.ca",
  "description": "News, updates, producer spotlights, and music production tips from BeatPass.",
  "isPartOf": {
    "@type": "WebSite",
    "name": "BeatPass",
    "url": "https://beatpass.ca",
    "description": "The Beat Licensing Platform"
  },
  "publisher": {
    "@type": "Organization",
    "name": "BeatPass",
    "url": "https://beatpass.ca",
    "logo": {
      "@type": "ImageObject",
      "url": "https://beatpass.ca/logo.png"
    }
  },
  "inLanguage": "en-US",
  "copyrightHolder": {
    "@type": "Organization",
    "name": "BeatPass"
  },
  "mainEntityOfPage": {
    "@type": "WebPage",
    "@id": "https://blog.beatpass.ca/"
  }
}
</script>
```

---

## 3. Add Organization Reference Schema (JSON-LD)

Add this to link back to the parent organization:

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "WebSite",
  "name": "BeatPass Blog",
  "alternateName": "BeatPass News & Updates",
  "url": "https://blog.beatpass.ca",
  "isPartOf": {
    "@type": "WebSite",
    "name": "BeatPass",
    "url": "https://beatpass.ca"
  },
  "publisher": {
    "@type": "Organization",
    "name": "BeatPass",
    "url": "https://beatpass.ca"
  },
  "potentialAction": {
    "@type": "SearchAction",
    "target": {
      "@type": "EntryPoint",
      "urlTemplate": "https://blog.beatpass.ca/?s={search_term_string}"
    },
    "query-input": "required name=search_term_string"
  }
}
</script>
```

---

## 4. Add Essential Meta Tags

Add these meta tags to the blog's `<head>` section:

```html
<!-- Primary Meta Tags -->
<title>BeatPass Blog - News, Updates & Producer Spotlights</title>
<meta name="title" content="BeatPass Blog - News, Updates & Producer Spotlights" />
<meta name="description" content="Stay updated with BeatPass news, producer spotlights, music production tips, and platform updates." />
<meta name="keywords" content="beatpass blog, music production, beat making, producer tips, music industry news, beat licensing news" />
<meta name="author" content="BeatPass" />
<meta name="robots" content="index, follow" />
<link rel="canonical" href="https://blog.beatpass.ca/" />

<!-- Open Graph / Facebook -->
<meta property="og:type" content="website" />
<meta property="og:url" content="https://blog.beatpass.ca/" />
<meta property="og:title" content="BeatPass Blog - News, Updates & Producer Spotlights" />
<meta property="og:description" content="Stay updated with BeatPass news, producer spotlights, and music production tips." />
<meta property="og:image" content="https://blog.beatpass.ca/og-image.png" />
<meta property="og:site_name" content="BeatPass" />
<meta property="og:locale" content="en_US" />

<!-- Twitter -->
<meta property="twitter:card" content="summary_large_image" />
<meta property="twitter:url" content="https://blog.beatpass.ca/" />
<meta property="twitter:title" content="BeatPass Blog - News, Updates & Producer Spotlights" />
<meta property="twitter:description" content="Stay updated with BeatPass news, producer spotlights, and music production tips." />
<meta property="twitter:image" content="https://blog.beatpass.ca/og-image.png" />
<meta property="twitter:site" content="@beatpasswav" />

<!-- Parent domain reference -->
<link rel="home" href="https://beatpass.ca/" />
```

> **Important**: `og:site_name` must be "BeatPass" (not "BeatPass Blog") for brand consistency.

---

## 5. Article Schema for Blog Posts

For each blog post, add this schema (usually handled by your CMS/theme):

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "{{ POST_TITLE }}",
  "description": "{{ POST_EXCERPT }}",
  "image": "{{ POST_IMAGE }}",
  "datePublished": "{{ POST_DATE }}",
  "dateModified": "{{ POST_MODIFIED }}",
  "author": {
    "@type": "Person",
    "name": "{{ AUTHOR_NAME }}"
  },
  "publisher": {
    "@type": "Organization",
    "name": "BeatPass",
    "url": "https://beatpass.ca",
    "logo": {
      "@type": "ImageObject",
      "url": "https://beatpass.ca/logo.png"
    }
  },
  "mainEntityOfPage": {
    "@type": "WebPage",
    "@id": "{{ POST_URL }}"
  },
  "isPartOf": {
    "@type": "Blog",
    "name": "BeatPass Blog",
    "url": "https://blog.beatpass.ca"
  }
}
</script>
```

---

## 6. Sitemap Configuration

Ensure your blog sitemap uses appropriate priorities:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <!-- Blog homepage: priority 0.7 (lower than parent's 1.0) -->
  <url>
    <loc>https://blog.beatpass.ca/</loc>
    <lastmod>2025-12-01</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.7</priority>
  </url>
  
  <!-- Blog posts: priority 0.6 -->
  <url>
    <loc>https://blog.beatpass.ca/producer-spotlight-december/</loc>
    <lastmod>2025-12-01</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  
  <!-- Category pages: priority 0.5 -->
  <url>
    <loc>https://blog.beatpass.ca/category/news/</loc>
    <lastmod>2025-12-01</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.5</priority>
  </url>
</urlset>
```

---

## 7. Platform-Specific Instructions

### If using Ghost:

1. Go to **Settings → Code injection**
2. Paste the JSON-LD schemas in the **Site Header** field
3. Go to **Settings → Meta data**
4. Set Twitter card to `@beatpasswav`

### If using WordPress:

1. Install **Yoast SEO** or **Rank Math** plugin
2. Go to **SEO → Social → Organization**
3. Set organization name to "BeatPass"
4. Add JSON-LD via theme's `header.php` or use a custom code plugin
5. Set `og:site_name` to "BeatPass" in social settings

### If using a static site generator:

Add the schemas to your base layout template's `<head>` section.

---

## 8. Internal Linking Strategy

Include links to sibling subdomains in blog posts where relevant:

```markdown
- Link to player: [Listen on BeatPass](https://open.beatpass.ca)
- Link to docs: [Read the documentation](https://docs.beatpass.ca)
- Link to main site: [Visit BeatPass](https://beatpass.ca)
```

Add these to your blog footer or sidebar for consistent cross-linking.

---

## Priority Hierarchy Summary

| Page Type | Priority | Changefreq |
|-----------|----------|------------|
| Blog homepage | 0.7 | daily |
| Blog posts | 0.6 | monthly |
| Category pages | 0.5 | weekly |
| Tag pages | 0.4 | weekly |
| Author pages | 0.4 | monthly |

---

## Verification Checklist

- [ ] robots.txt with sitemap reference added
- [ ] Blog schema with `isPartOf` relationship added
- [ ] WebSite schema with `isPartOf` relationship added
- [ ] Meta tags with `og:site_name` = "BeatPass" (not "BeatPass Blog")
- [ ] `<link rel="home" href="https://beatpass.ca/">` added
- [ ] Sitemap with appropriate priorities (homepage ≤ 0.7)
- [ ] Article schema on blog posts with publisher = BeatPass
- [ ] Internal links to sibling subdomains included

---

## Testing Your Implementation

1. **Google Rich Results Test**: https://search.google.com/test/rich-results
   - Enter: `https://blog.beatpass.ca`
   - Verify Blog and Organization schemas are detected

2. **Schema Markup Validator**: https://validator.schema.org/
   - Paste your page URL
   - Check for errors in structured data

3. **Meta Tags Preview**: https://metatags.io/
   - Preview how your blog appears on Google/social media

---

*Document created: December 1, 2025*
*For: BeatPass SEO Domain Hierarchy*
