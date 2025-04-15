import style from "./styles/search.scss"
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
// @ts-ignore
import { i18n } from "../i18n"
import { classNames } from "../util/lang"
import script from "./scripts/search.inline"

export interface SearchOptions {
  enablePreview: boolean
}

const defaultOptions: SearchOptions = {
  enablePreview: true,
}

export default ((userOpts?: Partial<SearchOptions>) => {
  const Search: QuartzComponent = ({ displayClass, cfg }: QuartzComponentProps) => {
    const opts = { ...defaultOptions, ...userOpts }
    const searchPlaceholder = i18n(cfg.locale).components.search.searchBarPlaceholder
    return (
      <div class={classNames(displayClass, "search")}>
        <button class="search-button" id="search-button">
          <p>{i18n(cfg.locale).components.search.title}</p>
          <svg role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 19.9 19.7">
            <title>Search</title>
            <g class="search-path" fill="none">
              <path stroke-linecap="square" d="M18.5 18.3l-5.4-5.4" />
              <circle cx="8" cy="8" r="7" />
            </g>
          </svg>
        </button>
        <div id="search-container">
          <div id="search-space">
            <div id="search-bar-wrapper">
              <input
                autocomplete="off"
                id="search-bar"
                name="search"
                type="text"
                aria-label={searchPlaceholder}
                placeholder={searchPlaceholder}
              />
              <div id="search-progress-bar" style="display: none;" />
            </div>
            {/* Container for search tip and progress bar */}
            <div class="search-header-container">
              <div class="search-info">
                Tip: Use ~ for semantic vector search (e.g. ~query) and # for tag search (e.g.
                #query)
              </div>
              {/* Progress bar, initially hidden */}
            </div>
            <div id="search-layout" data-preview={opts.enablePreview}>
              {/* Container for search results */}
              <div id="results-container"></div>
              {/* Conditionally render preview container */}
              {opts.enablePreview && <div id="preview-container"></div>}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Revert to assigning the script content string
  Search.afterDOMLoaded = script
  Search.css = style

  return Search
}) satisfies QuartzComponentConstructor
