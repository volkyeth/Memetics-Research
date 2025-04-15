import { pipeline, type FeatureExtractionPipeline, type ProgressCallback } from "@huggingface/transformers"
import FlexSearch from "flexsearch"
import { ContentDetails } from "../../plugins/emitters/contentIndex"
import { hammingDistance } from "../../util/hammingDistance"
import { FullSlug, normalizeRelativeURLs, resolveRelative } from "../../util/path"
import { registerEscapeHandler, removeAllChildren } from "./util"

interface Item {
  id: number
  slug: FullSlug
  textFragment?: string // Optional text fragment for vector search results
  title: string
  content: string
  tags: string[]
  distance?: number
  firstWords?: string // For preview highlighting
  lastWords?: string // For preview highlighting
}

// Can be expanded with things like "term" in the future
type SearchType = "basic" | "tags" | "vector"
let searchType: SearchType = "basic"
let currentSearchTerm: string = ""
const encoder = (str: string) => str.toLowerCase().split(/([^a-z]|[^\x00-\x7F])/)
let index = new FlexSearch.Document<Item>({
  charset: "latin:extra",
  encode: encoder,
  document: {
    id: "id",
    tag: "tags",
    index: [
      {
        field: "title",
        tokenize: "forward",
      },
      {
        field: "content",
        tokenize: "forward",
      },
      {
        field: "tags",
        tokenize: "forward",
      },
    ],
  },
})

const p = new DOMParser()
const fetchContentCache: Map<FullSlug, Element[]> = new Map()
const contextWindowWords = 30
const numSearchResults = 8
const numTagResults = 5

// --- State Variables ---
let modelLoadingStatus: 'idle' | 'loading' | 'ready' = 'idle';
let modelLoadingProgress: number = 0;
let modelPromise: Promise<FeatureExtractionPipeline> | null = null;
let searchProgressBar: HTMLElement | null = null;
let embedder: FeatureExtractionPipeline | null = null;

// --- Progress Callback ---
const progressCallback: ProgressCallback = (progress) => {
  console.log('Progress:', progress);
  if (progress.status === 'progress' && progress.file && progress.file.endsWith('.bin')) { // Only track main model file progress
    modelLoadingStatus = 'loading';
    modelLoadingProgress = progress.progress ?? 0;
    if (searchProgressBar) {
      searchProgressBar.style.setProperty('--progress', `${modelLoadingProgress}%`);
      searchProgressBar.style.display = 'inline-block'; // Show progress bar
      searchProgressBar.style.animationPlayState = 'running'; // Ensure animation runs
    }
    // Optionally update results area with loading state
    const results = document.getElementById("results-container");
    if (results && searchType === 'vector') {
      removeAllChildren(results);
      results.innerHTML = `<div class="result-card loading-model">
            <h3>Loading Model... (${Math.round(modelLoadingProgress)}%)</h3>
            <p>Semantic search will be available shortly.</p>
        </div>`;
    }

  } else if (progress.status === 'ready') {
    modelLoadingStatus = 'ready';
    modelLoadingProgress = 100; // Ensure it reaches 100%
    if (searchProgressBar) {
      searchProgressBar.style.display = 'none'; // Hide progress bar
      searchProgressBar.style.animationPlayState = 'paused'; // Pause animation
    }
    // Re-trigger search if the user was waiting
    if (searchType === 'vector' && currentSearchTerm) {
      const searchBar = document.getElementById("search-bar") as HTMLInputElement | null;
      if (searchBar) {
        // Simulate input event to trigger search now that model is ready
        console.log("Model ready, triggering search for:", currentSearchTerm)
        searchBar.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      }
    }
  } else if ((progress.status as any) === 'error') {
    console.error("Model loading failed:", progress);
    modelLoadingStatus = 'idle'; // Reset status on error
    if (searchProgressBar) {
      searchProgressBar.style.display = 'none';
      searchProgressBar.style.animationPlayState = 'paused';
    }
    const results = document.getElementById("results-container");
    if (results && searchType === 'vector') {
      removeAllChildren(results);
      results.innerHTML = `<div class="result-card error-model">
               <h3>Model Error</h3>
               <p>Could not load the semantic search model. Please try again later.</p>
           </div>`;
    }
  }
};


// --- Get Embedder Function ---
async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (embedder) {
    return embedder;
  }
  if (modelPromise) {
    return modelPromise;
  }

  console.log('Initializing model...');
  modelLoadingStatus = 'loading';
  if (searchProgressBar) {
    searchProgressBar.style.display = 'inline-block';
    searchProgressBar.style.setProperty('--progress', `0%`);
    searchProgressBar.style.animationPlayState = 'running';
  }

  modelPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { progress_callback: progressCallback })
    .then(loadedPipeline => {
      console.log('Model ready.');
      embedder = loadedPipeline as FeatureExtractionPipeline; // Store the loaded pipeline
      modelLoadingStatus = 'ready'; // Ensure status is ready
      if (searchProgressBar) {
        searchProgressBar.style.display = 'none';
        searchProgressBar.style.animationPlayState = 'paused';
      }
      modelPromise = null; // Clear promise once resolved
      return embedder;
    })
    .catch(error => {
      console.error("Failed to load model:", error);
      modelLoadingStatus = 'idle'; // Reset status on error
      modelPromise = null; // Clear the promise
      if (searchProgressBar) {
        searchProgressBar.style.display = 'none';
        searchProgressBar.style.animationPlayState = 'paused';
      }
      throw error; // Re-throw error to be caught by caller
    });

  return modelPromise;
}

const tokenizeTerm = (term: string) => {
  const tokens = term.split(/\s+/).filter((t) => t.trim() !== "")
  const tokenLen = tokens.length
  if (tokenLen > 1) {
    for (let i = 1; i < tokenLen; i++) {
      tokens.push(tokens.slice(0, i + 1).join(" "))
    }
  }

  return tokens.sort((a, b) => b.length - a.length) // always highlight longest terms first
}

function highlight(searchTerm: string, text: string, trim?: boolean) {
  const tokenizedTerms = tokenizeTerm(searchTerm)
  let tokenizedText = text.split(/\s+/).filter((t) => t !== "")

  let startIndex = 0
  let endIndex = tokenizedText.length - 1
  if (trim) {
    const includesCheck = (tok: string) =>
      tokenizedTerms.some((term) => tok.toLowerCase().startsWith(term.toLowerCase()))
    const occurrencesIndices = tokenizedText.map(includesCheck)

    let bestSum = 0
    let bestIndex = 0
    for (let i = 0; i < Math.max(tokenizedText.length - contextWindowWords, 0); i++) {
      const window = occurrencesIndices.slice(i, i + contextWindowWords)
      const windowSum = window.reduce((total, cur) => total + (cur ? 1 : 0), 0)
      if (windowSum >= bestSum) {
        bestSum = windowSum
        bestIndex = i
      }
    }

    startIndex = Math.max(bestIndex - contextWindowWords, 0)
    endIndex = Math.min(startIndex + 2 * contextWindowWords, tokenizedText.length - 1)
    tokenizedText = tokenizedText.slice(startIndex, endIndex)
  }

  const slice = tokenizedText
    .map((tok) => {
      // see if this tok is prefixed by any search terms
      for (const searchTok of tokenizedTerms) {
        if (tok.toLowerCase().includes(searchTok.toLowerCase())) {
          const regex = new RegExp(searchTok.toLowerCase(), "gi")
          return tok.replace(regex, `<span class="highlight">$&</span>`)
        }
      }
      return tok
    })
    .join(" ")

  return `${startIndex === 0 ? "" : "..."}${slice}${endIndex === tokenizedText.length - 1 ? "" : "..."
    }`
}

function highlightHTML(searchTerm: string, el: HTMLElement) {
  const p = new DOMParser()
  const tokenizedTerms = tokenizeTerm(searchTerm)
  const html = p.parseFromString(el.innerHTML, "text/html")

  const createHighlightSpan = (text: string) => {
    const span = document.createElement("span")
    span.className = "highlight"
    span.textContent = text
    return span
  }

  const highlightTextNodes = (node: Node, term: string) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const nodeText = node.nodeValue ?? ""
      const regex = new RegExp(term.toLowerCase(), "gi")
      const matches = nodeText.match(regex)
      if (!matches || matches.length === 0) return
      const spanContainer = document.createElement("span")
      let lastIndex = 0
      for (const match of matches) {
        const matchIndex = nodeText.indexOf(match, lastIndex)
        spanContainer.appendChild(document.createTextNode(nodeText.slice(lastIndex, matchIndex)))
        spanContainer.appendChild(createHighlightSpan(match))
        lastIndex = matchIndex + match.length
      }
      spanContainer.appendChild(document.createTextNode(nodeText.slice(lastIndex)))
      node.parentNode?.replaceChild(spanContainer, node)
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if ((node as HTMLElement).classList.contains("highlight")) return
      Array.from(node.childNodes).forEach((child) => highlightTextNodes(child, term))
    }
  }

  for (const term of tokenizedTerms) {
    highlightTextNodes(html.body, term)
  }

  return html.body
}

document.addEventListener("nav", async (e: CustomEventMap["nav"]) => {
  const currentSlug = e.detail.url
  const data = await fetchData
  const container = document.getElementById("search-container")
  const sidebar = container?.closest(".sidebar") as HTMLElement
  const searchButton = document.getElementById("search-button")
  const searchBar = document.getElementById("search-bar") as HTMLInputElement | null
  const searchBarWrapper = document.getElementById("search-bar-wrapper") as HTMLDivElement | null
  const searchLayout = document.getElementById("search-layout")
  const idDataMap = Object.keys(data) as FullSlug[]

  // Get static elements directly
  const results = document.getElementById("results-container") as HTMLDivElement | null;
  const preview = document.getElementById("preview-container") as HTMLDivElement | null; // This might be null if enablePreview is false
  const searchHeader = document.querySelector(".search-header-container") as HTMLDivElement | null;
  const searchInfo = document.querySelector(".search-info") as HTMLDivElement | null;
  // Assign searchProgressBar directly as it's now static in the component
  searchProgressBar = document.getElementById("search-progress-bar");


  const enablePreview = searchLayout?.dataset?.preview === "true" && preview // Check if preview element exists

  let previewInner: HTMLDivElement | undefined = undefined

  function hideSearch() {
    container?.classList.remove("active")
    if (searchBar) {
      searchBar.value = "" // clear the input when we dismiss the search
    }
    if (sidebar) {
      sidebar.style.zIndex = "unset"
    }
    // Check if elements exist before clearing
    if (results) {
      removeAllChildren(results)
    }
    if (preview) {
      removeAllChildren(preview)
    }
    if (searchLayout) {
      searchLayout.classList.remove("display-results")
    }

    searchType = "basic" // reset search type after closing

    searchButton?.focus()
  }

  function showSearch(searchTypeNew: SearchType) {
    searchType = searchTypeNew
    if (sidebar) {
      sidebar.style.zIndex = "1"
    }
    container?.classList.add("active")
    searchBar?.focus()
  }

  let currentHover: HTMLInputElement | null = null

  async function shortcutHandler(e: HTMLElementEventMap["keydown"]) {
    if (e.key === "k" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault()
      const searchBarOpen = container?.classList.contains("active")
      searchBarOpen ? hideSearch() : showSearch("basic")
      return
    } else if (e.shiftKey && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      // Hotkey to open tag search
      e.preventDefault()
      const searchBarOpen = container?.classList.contains("active")
      searchBarOpen ? hideSearch() : showSearch("tags")

      // add "#" prefix for tag search
      if (searchBar) searchBar.value = "#"
      return
    }

    if (currentHover) {
      currentHover.classList.remove("focus")
    }

    // If search is active, then we will render the first result and display accordingly
    if (!container?.classList.contains("active")) return
    if (e.key === "Enter") {
      // If result has focus, navigate to that one, otherwise pick first result
      if (results?.contains(document.activeElement)) {
        const active = document.activeElement as HTMLInputElement
        if (active.classList.contains("no-match")) return
        await displayPreview(active)
        active.click()
      } else {
        const anchor = document.getElementsByClassName("result-card")[0] as HTMLInputElement | null
        if (!anchor || anchor?.classList.contains("no-match")) return
        await displayPreview(anchor)
        anchor.click()
      }
    } else if (e.key === "ArrowUp" || (e.shiftKey && e.key === "Tab")) {
      e.preventDefault()
      if (results?.contains(document.activeElement)) {
        // If an element in results-container already has focus, focus previous one
        const currentResult = currentHover
          ? currentHover
          : (document.activeElement as HTMLInputElement | null)
        const prevResult = currentResult?.previousElementSibling as HTMLInputElement | null
        currentResult?.classList.remove("focus")
        prevResult?.focus()
        if (prevResult) currentHover = prevResult
        await displayPreview(prevResult)
      }
    } else if (e.key === "ArrowDown" || e.key === "Tab") {
      e.preventDefault()
      // The results should already been focused, so we need to find the next one.
      // The activeElement is the search bar, so we need to find the first result and focus it.
      if (document.activeElement === searchBar || currentHover !== null) {
        const firstResult = currentHover
          ? currentHover
          : (document.getElementsByClassName("result-card")[0] as HTMLInputElement | null)
        const secondResult = firstResult?.nextElementSibling as HTMLInputElement | null
        firstResult?.classList.remove("focus")
        secondResult?.focus()
        if (secondResult) currentHover = secondResult
        await displayPreview(secondResult)
      }
    }
  }

  const formatForDisplay = (term: string, id: number) => {
    const slug = idDataMap[id]
    return {
      id,
      slug,
      title: searchType === "tags" ? data[slug].title : highlight(term, data[slug].title ?? ""),
      content: highlight(term, data[slug].content ?? "", true),
      tags: highlightTags(term.substring(1), data[slug].tags),
    }
  }

  function highlightTags(term: string, tags: string[]) {
    if (!tags || searchType !== "tags") {
      return []
    }

    return tags
      .map((tag) => {
        if (tag.toLowerCase().includes(term.toLowerCase())) {
          return `<li><p class="match-tag">#${tag}</p></li>`
        } else {
          return `<li><p>#${tag}</p></li>`
        }
      })
      .slice(0, numTagResults)
  }

  function resolveUrl(slug: FullSlug, textFragment?: string): URL {
    const url = new URL(resolveRelative(currentSlug, slug), location.toString());
    if (textFragment) {
      url.hash = textFragment;
    }
    return url;
  }

  const resultToHTML = ({ slug, textFragment, title, content, tags, id, distance }: Item) => {
    const htmlTags = tags.length > 0 ? `<ul class="tags">${tags.join("")}</ul>` : ``
    const itemTile = document.createElement("a")
    itemTile.classList.add("result-card")
    if (id < 0) {
      // Vector search result
      itemTile.classList.add("vector-result")
      // Add rel="noopener" as required by text fragments spec
      itemTile.rel = "noopener"
    }
    itemTile.id = slug
    itemTile.href = resolveUrl(slug, textFragment).toString()

    const EMBEDDING_DIMENSIONS = 384
    // Add distance indicator for vector search results
    const distanceIndicator = distance !== undefined
      ? `<span class="vector-distance">Similarity: ${Math.round(100 - (100 * distance / EMBEDDING_DIMENSIONS))}%</span>`
      : '';

    // For vector results, wrap content in highlight span
    const contentHtml = id < 0
      ? `<p><span class="highlight">${content}</span></p>`
      : `<p>${content}</p>`;

    itemTile.innerHTML = `<h3>${title}${id < 0 ? distanceIndicator : ''}</h3>${htmlTags}${enablePreview && window.innerWidth > 600 ? "" : contentHtml}`
    itemTile.addEventListener("click", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return

      // If this is a vector result, scroll the target text into view after a short delay
      // to allow the page to load and text fragments to be processed
      if (id < 0) {
        event.preventDefault()
        const targetUrl = itemTile.href
        window.location.href = targetUrl
        setTimeout(() => {
          const highlight = document.querySelector("::target-text")
          if (highlight) {
            highlight.scrollIntoView({ block: "center", behavior: "smooth" })
          }
        }, 500)
      }

      hideSearch()
    })

    const handler = (event: MouseEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      hideSearch()
    }

    async function onMouseEnter(ev: MouseEvent) {
      if (!ev.target) return
      const target = ev.target as HTMLInputElement
      await displayPreview(target)
    }

    itemTile.addEventListener("mouseenter", onMouseEnter)
    window.addCleanup(() => itemTile.removeEventListener("mouseenter", onMouseEnter))
    itemTile.addEventListener("click", handler)
    window.addCleanup(() => itemTile.removeEventListener("click", handler))

    return itemTile
  }

  // Store current results for preview highlighting
  let currentResults: Item[] | null = null;

  async function displayResults(finalResults: Item[]) {
    if (!results) return

    // Store results for preview highlighting
    currentResults = finalResults;

    removeAllChildren(results)

    // Check if there are vector results
    const hasVectorResults = finalResults.some(item => item.id < 0)

    if (finalResults.length === 0) {
      results.innerHTML = `<a class="result-card no-match">
          <h3>No results.</h3>
          <p>Try another search term?</p>
      </a>`
    } else {
      // Add a header for vector results if present
      if (hasVectorResults && searchType === "vector") {
        const header = document.createElement("div")
        header.className = "search-results-header"
        header.textContent = "Semantic Search Results"
        results.appendChild(header)

        // Append vector results first
        const vectorResultElements = finalResults
          .filter(item => item.id < 0)
          .map(resultToHTML)
        results.append(...vectorResultElements)

        // Add header for text search results
        const textHeader = document.createElement("div")
        textHeader.className = "search-results-header"
        textHeader.textContent = "Text Search Results"
        results.appendChild(textHeader)

        // Append text search results
        const textResultElements = finalResults
          .filter(item => item.id >= 0)
          .map(resultToHTML)
        results.append(...textResultElements)
      } else {
        results.append(...finalResults.map(resultToHTML))
      }
    }

    if (finalResults.length === 0 && preview) {
      // no results, clear previous preview
      removeAllChildren(preview)
    } else {
      // For vector search, focus on first vector result
      // For regular search, focus on first result
      const firstResult = searchType === "vector"
        ? results.querySelector(".vector-result") as HTMLElement
        : results.firstElementChild as HTMLElement;

      if (firstResult) {
        // Remove focus from any previously focused result
        results.querySelectorAll(".focus").forEach(el => el.classList.remove("focus"));
        // Add focus to first result
        firstResult.classList.add("focus")
        currentHover = firstResult as HTMLInputElement
        await displayPreview(firstResult)
      }
    }
  }

  async function fetchContent(slug: FullSlug): Promise<Element[]> {
    if (fetchContentCache.has(slug)) {
      return fetchContentCache.get(slug) as Element[]
    }

    const targetUrl = resolveUrl(slug).toString()
    const contents = await fetch(targetUrl)
      .then((res) => res.text())
      .then((contents) => {
        if (contents === undefined) {
          throw new Error(`Could not fetch ${targetUrl}`)
        }
        const html = p.parseFromString(contents ?? "", "text/html")
        normalizeRelativeURLs(html, targetUrl)
        return [...html.getElementsByClassName("popover-hint")]
      })

    fetchContentCache.set(slug, contents)
    return contents
  }

  async function displayPreview(el: HTMLElement | null) {
    if (!searchLayout || !enablePreview || !el || !preview) return
    const slug = el.id as FullSlug
    const item = currentResults?.find(r => r.slug === slug);

    const innerDiv = await fetchContent(slug).then((contents) => {
      // For vector search results, only use chunk highlighting
      // For regular search, use keyword highlighting
      const elements = contents.flatMap((el) => {
        const clone = el.cloneNode(true) as HTMLElement;
        if (item?.id === -1) {
          // Vector search - no keyword highlighting, but preserve HTML structure
          return [clone];
        } else {
          // Regular search - highlight keywords
          return [...highlightHTML(currentSearchTerm, clone).children];
        }
      });

      // If this is a vector search result, highlight the chunk in the preview
      if (item?.firstWords && item?.lastWords) {
        const firstWords = item.firstWords;
        const lastWords = item.lastWords;

        for (const element of elements) {
          // Function to process text nodes recursively
          const processNode = (node: Node) => {
            if (node.nodeType === Node.TEXT_NODE && node.textContent) {
              const text = node.textContent;
              const startIndex = text.indexOf(firstWords);
              if (startIndex !== -1) {
                const endIndex = text.lastIndexOf(lastWords) + lastWords.length;
                if (endIndex > startIndex) {
                  const before = text.substring(0, startIndex);
                  const highlight = text.substring(startIndex, endIndex);
                  const after = text.substring(endIndex);

                  const span = document.createElement('span');
                  span.className = 'highlight vector-highlight';
                  span.textContent = highlight;

                  const fragment = document.createDocumentFragment();
                  if (before) fragment.appendChild(document.createTextNode(before));
                  fragment.appendChild(span);
                  if (after) fragment.appendChild(document.createTextNode(after));

                  node.parentNode?.replaceChild(fragment, node);
                }
              }
            } else if (node.nodeType === Node.ELEMENT_NODE) {
              // Recursively process child nodes
              Array.from(node.childNodes).forEach(processNode);
            }
          };

          // Process all nodes in the element
          processNode(element);
        }
      }

      return elements;
    });

    previewInner = document.createElement("div")
    previewInner.classList.add("preview-inner")
    previewInner.append(...innerDiv)
    preview.replaceChildren(previewInner)

    // Scroll to highlight with a small delay to ensure content is rendered
    setTimeout(() => {
      const highlight = preview.querySelector(".vector-highlight, .highlight")
      if (highlight) {
        // Calculate if highlight is in view
        const previewRect = preview.getBoundingClientRect();
        const highlightRect = highlight.getBoundingClientRect();
        const isInView = (
          highlightRect.top >= previewRect.top &&
          highlightRect.bottom <= previewRect.bottom
        );

        if (!isInView) {
          highlight.scrollIntoView({
            block: "center",
            behavior: "smooth",
            inline: "nearest"
          });
        }
      }
    }, 100);
  }

  async function onType(e: HTMLElementEventMap["input"]) {
    if (!searchLayout || !index) return
    const currentVal = (e.target as HTMLInputElement).value
    const term = currentVal.trim()

    // Determine search type early
    const newSearchType = term.startsWith("#") ? "tags" :
      term.startsWith("~") || term.startsWith("˜") ? "vector" : "basic";

    // Update search term only if it has changed (excluding prefixes)
    let newSearchTerm = term;
    if (newSearchType === "tags" || newSearchType === "vector") {
      newSearchTerm = term.substring(1).trim();
    }

    // Pre-emptively start model download if switching to vector search
    if (newSearchType === 'vector' && modelLoadingStatus === 'idle') {
      console.log("Vector prefix detected, initializing model download...");
      getEmbedder().catch(error => {
        console.error("Pre-emptive model initialization failed:", error);
        // Error state will be handled later in the function if needed
      });
    }

    // Only proceed if search term or type has actually changed, or if it's empty
    if (newSearchTerm === currentSearchTerm && newSearchType === searchType && term !== "") {
      console.log("Search term and type unchanged, skipping.")
      return;
    }

    currentSearchTerm = newSearchTerm;
    searchType = newSearchType; // Update global searchType

    console.log(`Search type: ${searchType}, Term: '${currentSearchTerm}'`);


    const shouldDisplayResults = term !== "" && term !== "#" && term !== "~" && term !== "˜";
    searchLayout.classList.toggle("display-results", shouldDisplayResults);

    let searchResults: FlexSearch.SimpleDocumentSearchResultSetUnit[] = []
    let vectorResults: Item[] = []
    // results and preview are now potentially null, check before using
    // const results = document.getElementById("results-container"); // Already defined above
    // const preview = document.getElementById("preview-container"); // Already defined above


    if (!shouldDisplayResults) {
      if (results) removeAllChildren(results); // Clear results if search term is empty/prefix only
      if (preview) removeAllChildren(preview);
      return;
    }

    if (searchType === "vector") {
      // Always try to get the embedder - it handles initialization and loading states
      // Call was moved earlier, but we still need to await the promise if it exists
      // or handle the case where it failed pre-emptively.
      try {
        if (modelPromise) {
          await modelPromise;
        } else if (!embedder && modelLoadingStatus !== 'loading') {
          // This case might happen if pre-emptive call failed before promise was set
          await getEmbedder();
        }
        // If embedder exists or promise resolved successfully, modelLoadingStatus should be 'ready'
        // If loading, the check below will handle it.
      } catch (error) {
        console.error("Failed to initialize embedder for search:", error);
        if (results) {
          removeAllChildren(results);
          results.innerHTML = `<div class="result-card error-model">
                    <h3>Model Error</h3>
                    <p>Could not load the semantic search model. Please try again later.</p>
                </div>`;
        }
        if (preview) removeAllChildren(preview);
        return;
      }

      // Check status *after* attempting to get embedder
      if (modelLoadingStatus === 'ready' && currentSearchTerm) {
        // Model is ready and there's a search term, proceed with vector search
        console.log("Model ready, performing vector search for:", currentSearchTerm);
        vectorResults = await findSimilarContent(currentSearchTerm, data);
        // Also perform regular search for comparison
        searchResults = await index.searchAsync({
          query: currentSearchTerm,
          limit: numSearchResults,
          index: ["title", "content"],
        });
      } else if (modelLoadingStatus === 'loading') {
        console.log("Model still loading, search deferred.");
        if (results) { // Update loading message (progress handled by callback)
          removeAllChildren(results);
          results.innerHTML = `<div class="result-card loading-model">
                    <h3>Loading Model... (${Math.round(modelLoadingProgress)}%)</h3>
                    <p>Semantic search will be available shortly.</p>
                </div>`;
        }
        if (preview) removeAllChildren(preview);
        return; // Don't search yet
      } else if (modelLoadingStatus !== 'ready' && !currentSearchTerm && term.startsWith('~')) {
        // Model is not ready (or idle/error), or term is just the prefix
        console.log("Vector search prefix used, but no search term provided or model not ready.");
        if (modelLoadingStatus === 'idle' || modelLoadingStatus === 'error') { // Show error if applicable
          if (results && !results.querySelector('.error-model') && !results.querySelector('.loading-model')) {
            removeAllChildren(results);
            results.innerHTML = `<div class="result-card error-model">
                        <h3>Model Unavailable</h3>
                        <p>The semantic search model failed to load or is unavailable.</p>
                    </div>`;
          }
        } else if (modelLoadingStatus === 'loading' && results && !results.querySelector('.loading-model')) {
          // Ensure loading message is shown if somehow missed
          removeAllChildren(results);
          results.innerHTML = `<div class="result-card loading-model">
                    <h3>Loading Model... (${Math.round(modelLoadingProgress)}%)</h3>
                    <p>Semantic search will be available shortly.</p>
                </div>`;
        }

        if (results && term.startsWith('~') && !currentSearchTerm) {
          // Clear if only prefix is typed, regardless of model state
          removeAllChildren(results);
        }
        if (preview) removeAllChildren(preview);
        return;
      }
    } else if (searchType === "tags") {
      // currentSearchTerm already has the tag prefix removed
      const separatorIndex = currentSearchTerm.indexOf(" ")
      if (separatorIndex != -1 && currentSearchTerm.substring(separatorIndex + 1).trim() !== "") {
        // Tag + Query
        const tag = currentSearchTerm.substring(0, separatorIndex).trim();
        const query = currentSearchTerm.substring(separatorIndex + 1).trim();
        console.log(`Tag search: tag='${tag}', query='${query}'`);
        searchResults = await index.searchAsync({
          query: query,
          limit: Math.max(numSearchResults * 2, 10000), // Fetch more to ensure filtering works
          index: ["title", "content"],
          tag: tag, // Use flexsearch's tag filter
        })
        // Flexsearch returns results per index AND filtered by tag. We just need to limit the final count.
        searchResults.forEach(searchResult => {
          searchResult.result = searchResult.result.slice(0, numSearchResults)
        });
        // Keep searchType as "tags" but use the query for highlighting content/title
        currentSearchTerm = query // Store query part for highlighting
      } else if (currentSearchTerm !== "") {
        // Pure Tag Search
        console.log(`Tag search: pure tag='${currentSearchTerm}'`);
        searchResults = await index.searchAsync({
          query: currentSearchTerm,
          limit: numSearchResults,
          index: ["tags"], // Search only the tags index
        })
        // No query term for highlighting content/title
      } else {
        // Just '#' was typed
        console.log("Tag search prefix used, but no tag provided.");
        if (results) removeAllChildren(results);
        if (preview) removeAllChildren(preview);
        return;
      }
    } else if (searchType === "basic" && currentSearchTerm) {
      console.log("Basic search:", currentSearchTerm);
      searchResults = await index.searchAsync({
        query: currentSearchTerm,
        limit: numSearchResults,
        index: ["title", "content"],
      })
    }

    // --- Process Results ---
    const getByField = (field: string): number[] => {
      const fieldResults = searchResults.find((x) => x.field === field); // Use find for single field
      return fieldResults ? [...fieldResults.result] as number[] : [];
    }

    // Use a Map to store best result per ID, prioritizing title matches
    const rankedResults = new Map<number, { field: string }>();
    getByField("title").forEach(id => rankedResults.set(id, { field: "title" }));
    getByField("content").forEach(id => {
      if (!rankedResults.has(id)) {
        rankedResults.set(id, { field: "content" });
      }
    });
    // Add tag results only if it was a PURE tag search
    if (searchType === "tags" && currentSearchTerm.indexOf(" ") === -1) {
      getByField("tags").forEach(id => {
        if (!rankedResults.has(id)) {
          rankedResults.set(id, { field: "tags" });
        }
      });
    }

    const allIds = Array.from(rankedResults.keys());

    let finalResults: Item[] = []

    // Format results from regular/tag search
    const regularResultsFormatted = allIds.map(id => {
      const slug = idDataMap[id];
      if (!data[slug]) return null; // Basic data validation

      let titleHighlightTerm = currentSearchTerm;
      let contentHighlightTerm = currentSearchTerm;
      let tagHighlightTerm = "";

      if (searchType === "tags") {
        const separatorIndex = term.substring(1).trim().indexOf(" "); // Use original input 'term' for logic
        if (separatorIndex !== -1) {
          // Tag + Query
          tagHighlightTerm = term.substring(1, separatorIndex + 1).trim();
          titleHighlightTerm = term.substring(separatorIndex + 2).trim();
          contentHighlightTerm = titleHighlightTerm;
        } else {
          // Pure Tag
          tagHighlightTerm = term.substring(1).trim();
          titleHighlightTerm = ""; // No highlighting for title/content in pure tag search
          contentHighlightTerm = "";
        }
        console.log(`Formatting tag result: tagTerm='${tagHighlightTerm}', queryTerm='${contentHighlightTerm}'`)
        return {
          id,
          slug,
          title: titleHighlightTerm ? highlight(titleHighlightTerm, data[slug].title ?? "") : data[slug].title,
          content: contentHighlightTerm ? highlight(contentHighlightTerm, data[slug].content ?? "", true) : "", // Don't show content snippet for pure tag search maybe? Or show non-highlighted?
          tags: highlightTags(tagHighlightTerm, data[slug].tags), // Always highlight tags based on tagTerm
        };
      } else {
        // Basic or Vector (where regular results are also shown)
        return formatForDisplay(currentSearchTerm, id); // Use original formatForDisplay for basic
      }
    }).filter(item => item !== null) as Item[];


    if (searchType === "vector" && modelLoadingStatus === 'ready') {
      // Combine vector results (already formatted) and regular results
      // Filter out duplicates based on slug, prioritizing vector results
      const regularResultsFiltered = regularResultsFormatted.filter(regResult =>
        !vectorResults.some(vecResult => vecResult.slug === regResult.slug)
      );
      finalResults = [...vectorResults, ...regularResultsFiltered];
      console.log(`Combined ${vectorResults.length} vector and ${regularResultsFiltered.length} regular results.`);
    } else {
      // Basic or Tag search results
      finalResults = regularResultsFormatted;
      console.log(`Displaying ${finalResults.length} ${searchType} results.`);
    }

    // Display combined/formatted results
    await displayResults(finalResults);
  }

  document.addEventListener("keydown", shortcutHandler)
  window.addCleanup(() => document.removeEventListener("keydown", shortcutHandler))
  searchButton?.addEventListener("click", () => showSearch("basic"))
  window.addCleanup(() => searchButton?.removeEventListener("click", () => showSearch("basic")))
  searchBar?.addEventListener("input", onType)
  window.addCleanup(() => searchBar?.removeEventListener("input", onType))

  registerEscapeHandler(container, hideSearch)
  await fillDocument(data)
})

/**
 * Fills flexsearch document with data
 * @param index index to fill
 * @param data data to fill index with
 */
async function fillDocument(data: { [key: FullSlug]: ContentDetails }) {
  let id = 0
  const promises: Array<Promise<unknown>> = []
  for (const [slug, fileData] of Object.entries<ContentDetails>(data)) {
    promises.push(
      index.addAsync(id++, {
        id,
        slug: slug as FullSlug,
        title: fileData.title,
        content: fileData.content,
        tags: fileData.tags,
      }),
    )
  }

  return await Promise.all(promises)
}

// Add function to decode base64 embedding to Uint8Array
function decodeEmbedding(embedding: string): Uint8Array {
  try {
    // Decode base64, then handle potential comma separation (robustness)
    const decodedString = atob(embedding);
    // Check if it looks like comma-separated numbers
    if (/^[\d,-.]+$/.test(decodedString)) {
      return new Uint8Array(decodedString.split(",").map(Number));
    } else {
      // Assume it's a raw byte string
      return new Uint8Array(Array.from(decodedString).map(char => char.charCodeAt(0)));
    }
  } catch (error) {
    console.error("Error decoding embedding:", error, "Input (first 50 chars):", embedding.substring(0, 50));
    return new Uint8Array(); // Return empty array on error
  }
}

// Function to find similar content based on embeddings
async function findSimilarContent(query: string, data: { [key: FullSlug]: ContentDetails }): Promise<Item[]> {
  if (modelLoadingStatus !== 'ready' || !embedder) {
    console.warn("findSimilarContent called but model is not ready.");
    return []; // Should not happen if onType logic is correct, but safeguard
  }
  if (!query) {
    console.log("Empty query provided to findSimilarContent.");
    return [];
  }

  try {
    console.log("Embedding query:", query)
    // Embed the query
    const queryEmbeddingResult = await embedder(query, { // Use the stored embedder instance
      pooling: 'cls',
      precision: "ubinary", // Match the precision used during indexing
      quantize: true // Match quantization used during indexing
    });

    // Check if the result is valid and has the expected structure
    if (!queryEmbeddingResult || typeof queryEmbeddingResult.tolist !== 'function' || !queryEmbeddingResult.dims || queryEmbeddingResult.dims.length < 2) {
      console.error('Invalid query embedding result structure:', queryEmbeddingResult);
      return [];
    }

    const queryEmbeddingList = queryEmbeddingResult.tolist();
    if (!Array.isArray(queryEmbeddingList) || queryEmbeddingList.length === 0 || !Array.isArray(queryEmbeddingList[0])) {
      console.error('Invalid query embedding result tolist():', queryEmbeddingList);
      return [];
    }

    // Explicitly create Uint8Array
    const queryEmbeddingUint8 = new Uint8Array(queryEmbeddingList[0]);


    // Validate the query embedding
    if (!queryEmbeddingUint8 || queryEmbeddingUint8.length === 0) {
      console.error('Failed to generate valid query embedding (empty array).');
      return [];
    }
    const expectedDim = queryEmbeddingResult.dims[1]; // Get expected dimensions
    console.log(`Query embedded. Dimensions: ${expectedDim}`);


    // Calculate distances for all chunks
    const results: Array<{ slug: FullSlug, distance: number, chunk: string }> = [];

    for (const [slug, fileData] of Object.entries<ContentDetails>(data)) {
      // Ensure chunkEmbeddings exist and is an array
      if (!fileData.chunkEmbeddings || !Array.isArray(fileData.chunkEmbeddings) || fileData.chunkEmbeddings.length === 0) continue;

      for (const chunkData of fileData.chunkEmbeddings) {
        // Ensure chunkData has embedding and content properties
        if (!chunkData || typeof chunkData.embedding !== 'string' || typeof chunkData.content !== 'string') {
          console.warn(`Skipping invalid chunkData for slug ${slug}:`, chunkData);
          continue;
        }

        try {
          const chunkEmbeddingUint8 = decodeEmbedding(chunkData.embedding);
          // Validate the chunk embedding
          if (!chunkEmbeddingUint8 || chunkEmbeddingUint8.length === 0) {
            console.warn(`Skipping chunk for slug ${slug} due to empty embedding after decoding.`);
            continue;
          }
          if (chunkEmbeddingUint8.length !== expectedDim) {
            console.warn(`Skipping chunk for slug ${slug} due to mismatched embedding dimensions. Expected: ${expectedDim}, Got: ${chunkEmbeddingUint8.length}. Content: ${chunkData.content.substring(0, 30)}...`);
            continue; // Skip if dimensions mismatch
          }

          const distance = hammingDistance(queryEmbeddingUint8, chunkEmbeddingUint8);

          results.push({
            slug: slug as FullSlug,
            distance,
            chunk: chunkData.content
          });
        } catch (error) {
          console.error(`Error processing embedding for ${slug}, chunk: ${chunkData.content.substring(0, 50)}...`, error);
        }
      }
    }
    console.log(`Calculated distances for ${results.length} chunks.`);


    // Sort by distance (smaller is better)
    results.sort((a, b) => a.distance - b.distance);

    // Deduplicate by source document, keeping the best score (lowest distance) for each document
    const bestResultsPerSlug = new Map<FullSlug, { distance: number, chunk: string }>();
    for (const result of results) {
      if (!bestResultsPerSlug.has(result.slug) || result.distance < bestResultsPerSlug.get(result.slug)!.distance) {
        bestResultsPerSlug.set(result.slug, { distance: result.distance, chunk: result.chunk });
      }
    }

    // Convert map back to array and sort again (as map iteration order isn't guaranteed for sorting)
    const deduplicatedSorted = Array.from(bestResultsPerSlug.entries())
      .map(([slug, data]) => ({ slug, ...data }))
      .sort((a, b) => a.distance - b.distance);

    console.log(`Deduplicated to ${deduplicatedSorted.length} results.`);


    // Take top 5
    const topResults = deduplicatedSorted.slice(0, 5);

    // Format results for display
    return topResults.map(result => {
      // Get first and last words from the chunk for text fragment
      const words = result.chunk.trim().split(/\s+/);
      if (words.length < 1) return null; // Should not happen with valid chunks

      const firstWords = words.slice(0, Math.min(5, words.length)).join(' '); // Use more words for robustness
      const lastWords = words.length > 5
        ? words.slice(Math.max(words.length - 5, 0)).join(' ')
        : firstWords;


      // Create text fragment with start and end text, ensure encoding
      const textFragment = `#:~:text=${encodeURIComponent(firstWords)}${words.length > 5 ? ',' + encodeURIComponent(lastWords) : ''}`;


      // Ensure data for the slug exists before accessing title/tags
      if (!data[result.slug]) {
        console.warn(`Data not found for slug ${result.slug} when formatting vector results.`);
        return null;
      }

      return {
        id: -1, // Use negative IDs to distinguish from regular search results
        slug: result.slug, // Keep the original slug
        textFragment, // Store fragment separately
        title: data[result.slug].title ?? "Untitled", // Provide default title
        content: result.chunk, // Keep original content for preview
        tags: data[result.slug].tags ?? [], // Provide default empty tags array
        distance: result.distance,
        firstWords, // Store for preview highlighting
        lastWords, // Store for preview highlighting
      };
    }).filter(Boolean) as Item[]; // Filter out any nulls from formatting or data issues
  } catch (error) {
    console.error("Error in vector search execution:", error);
    return []; // Return empty array on error
  }
}