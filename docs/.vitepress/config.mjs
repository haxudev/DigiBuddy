import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'DigiBuddy',
  description: 'Hosted agent runtime on Azure Functions for Microsoft and Azure workflows.',
  base: '/DigiBuddy/',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    siteTitle: 'DigiBuddy',
    nav: [
      { text: 'Guide', link: '/quickstart' },
      { text: 'Features', link: '/features' },
      { text: 'API', link: '/api' },
      { text: 'Architecture', link: '/architecture' },
      { text: 'GitHub', link: 'https://github.com/haxudev/DigiBuddy' }
    ],
    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Quickstart', link: '/quickstart' }
        ]
      },
      {
        text: 'Core',
        items: [
          { text: 'Features', link: '/features' },
          { text: 'API Reference', link: '/api' }
        ]
      },
      {
        text: 'Deployment',
        items: [
          { text: 'Architecture', link: '/architecture' }
        ]
      }
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/haxudev/DigiBuddy' }
    ],
    footer: {
      message: 'Hosted agent runtime on Azure Functions.',
      copyright: 'Copyright © 2026 DigiBuddy'
    },
    outline: {
      level: [2, 3],
      label: 'On this page'
    },
    search: {
      provider: 'local'
    },
    docFooter: {
      prev: 'Previous page',
      next: 'Next page'
    }
  },
  head: [
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'DigiBuddy' }],
    ['meta', { property: 'og:description', content: 'Hosted agent runtime on Azure Functions for Microsoft and Azure workflows.' }]
  ]
})
