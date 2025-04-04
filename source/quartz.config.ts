import { QuartzConfig } from "./quartz/cfg"
import * as Plugin from "./quartz/plugins"

/**
 * Quartz 4.0 Configuration
 *
 * See https://quartz.jzhao.xyz/configuration for more information.
 */
const config: QuartzConfig = {
  configuration: {
    pageTitle: "Emergent Research",
    pageTitleSuffix: " | Open Research Institute",
    enableSPA: true,
    enablePopovers: true,
    analytics: {
      provider: "plausible",
    },
    locale: "en-US",
    baseUrl: "quartz.jzhao.xyz",
    ignorePatterns: ["private", "templates", ".obsidian"],
    defaultDateType: "created",
    theme: {
      fontOrigin: "googleFonts",
      cdnCaching: true,
      typography: {
        header: "Special Elite",
        body: "Special Elite",
        code: "Special Elite",
      },
      colors: {
        lightMode: {
          light: "#f9f9f9",
          lightgray: "#e8e8e8",
          gray: "#b8b8b8",
          darkgray: "#4e4e4e",
          dark: "#333333",
          secondary: "#5e3a98",
          tertiary: "#26a69a",
          highlight: "rgba(94, 58, 152, 0.15)",
          textHighlight: "#e67e2288",
        },
        darkMode: {
          light: "#f9f9f9",
          lightgray: "#e8e8e8",
          gray: "#b8b8b8",
          darkgray: "#4e4e4e",
          dark: "#333333",
          secondary: "#5e3a98",
          tertiary: "#26a69a",
          highlight: "rgba(94, 58, 152, 0.15)",
          textHighlight: "#e67e2288",
        },
      },
    },
  },
  plugins: {
    transformers: [
      Plugin.FrontMatter(),
      Plugin.CreatedModifiedDate({
        priority: ["frontmatter", "filesystem"],
      }),
      Plugin.SyntaxHighlighting({
        theme: {
          light: "github-light",
          dark: "github-dark",
        },
        keepBackground: false,
      }),
      Plugin.ObsidianFlavoredMarkdown({ enableInHtmlEmbed: false }),
      Plugin.GitHubFlavoredMarkdown(),
      Plugin.TableOfContents(),
      Plugin.CrawlLinks({ markdownLinkResolution: "shortest" }),
      Plugin.Description(),
      Plugin.Latex({ renderEngine: "katex" }),
    ],
    filters: [Plugin.RemoveDrafts()],
    emitters: [
      Plugin.AliasRedirects(),
      Plugin.ComponentResources(),
      Plugin.ContentPage(),
      Plugin.FolderPage(),
      Plugin.TagPage(),
      Plugin.ContentIndex({
        enableSiteMap: true,
        enableRSS: true,
      }),
      Plugin.Assets(),
      Plugin.Static(),
      Plugin.NotFoundPage(),
    ],
  },
}

export default config
