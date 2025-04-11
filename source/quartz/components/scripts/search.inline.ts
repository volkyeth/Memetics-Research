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
  const searchLayout = document.getElementById("search-layout")
  const idDataMap = Object.keys(data) as FullSlug[]

  // Add search tip below search input
  if (searchBar && !document.querySelector(".search-info")) {
    const searchInfo = document.createElement("div")
    searchInfo.className = "search-info"
    searchInfo.innerHTML = "Tip: Use ~ for semantic vector search (e.g. ~neural networks)"
    searchBar.insertAdjacentElement('afterend', searchInfo)
  }

  const appendLayout = (el: HTMLElement) => {
    if (searchLayout?.querySelector(`#${el.id}`) === null) {
      searchLayout?.appendChild(el)
    }
  }

  const enablePreview = searchLayout?.dataset?.preview === "true"
  let preview: HTMLDivElement | undefined = undefined
  let previewInner: HTMLDivElement | undefined = undefined
  const results = document.createElement("div")
  results.id = "results-container"
  appendLayout(results)

  if (enablePreview) {
    preview = document.createElement("div")
    preview.id = "preview-container"
    appendLayout(preview)
  }

  function hideSearch() {
    container?.classList.remove("active")
    if (searchBar) {
      searchBar.value = "" // clear the input when we dismiss the search
    }
    if (sidebar) {
      sidebar.style.zIndex = "unset"
    }
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

    // Add distance indicator for vector search results
    const distanceIndicator = distance !== undefined
      ? `<span class="vector-distance">Similarity: ${Math.round(100 - (distance / 2))}%</span>`
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
    currentSearchTerm = (e.target as HTMLInputElement).value
    searchLayout.classList.toggle("display-results", currentSearchTerm !== "")
    searchType = currentSearchTerm.startsWith("#") ? "tags" :
      currentSearchTerm.startsWith("~") ? "vector" : "basic"

    let searchResults: FlexSearch.SimpleDocumentSearchResultSetUnit[]
    let vectorResults: Item[] = []

    if (searchType === "vector") {
      // Vector similarity search
      currentSearchTerm = currentSearchTerm.substring(1).trim()
      vectorResults = await findSimilarContent(currentSearchTerm, data)

      // Also perform regular search for comparison
      searchResults = await index.searchAsync({
        query: currentSearchTerm,
        limit: numSearchResults,
        index: ["title", "content"],
      })
    } else if (searchType === "tags") {
      currentSearchTerm = currentSearchTerm.substring(1).trim()
      const separatorIndex = currentSearchTerm.indexOf(" ")
      if (separatorIndex != -1) {
        // search by title and content index and then filter by tag (implemented in flexsearch)
        const tag = currentSearchTerm.substring(0, separatorIndex)
        const query = currentSearchTerm.substring(separatorIndex + 1).trim()
        searchResults = await index.searchAsync({
          query: query,
          // return at least 10000 documents, so it is enough to filter them by tag (implemented in flexsearch)
          limit: Math.max(numSearchResults, 10000),
          index: ["title", "content"],
          tag: tag,
        })
        for (let searchResult of searchResults) {
          searchResult.result = searchResult.result.slice(0, numSearchResults)
        }
        // set search type to basic and remove tag from term for proper highlightning and scroll
        searchType = "basic"
        currentSearchTerm = query
      } else {
        // default search by tags index
        searchResults = await index.searchAsync({
          query: currentSearchTerm,
          limit: numSearchResults,
          index: ["tags"],
        })
      }
    } else if (searchType === "basic") {
      searchResults = await index.searchAsync({
        query: currentSearchTerm,
        limit: numSearchResults,
        index: ["title", "content"],
      })
    }

    const getByField = (field: string): number[] => {
      const results = searchResults.filter((x) => x.field === field)
      return results.length === 0 ? [] : ([...results[0].result] as number[])
    }

    // order titles ahead of content
    const allIds: Set<number> = new Set([
      ...getByField("title"),
      ...getByField("content"),
      ...getByField("tags"),
    ])

    let finalResults: Item[] = []

    if (searchType === "vector" && vectorResults.length > 0) {
      // For vector search, we already highlighted the content in findSimilarContent
      finalResults = [
        ...vectorResults,
        ...([...allIds].map(id => formatForDisplay(currentSearchTerm, id)))
      ]
    } else {
      finalResults = [...allIds].map(id => formatForDisplay(currentSearchTerm, id))
    }

    await displayResults(finalResults)
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
    const binaryString = atob(embedding);
    return new Uint8Array(Array.from(binaryString, c => c.charCodeAt(0)));
  } catch (error) {
    console.error("Error decoding embedding:", error);
    return new Uint8Array();
  }
}

// Function to find similar content based on embeddings
async function findSimilarContent(query: string, data: { [key: FullSlug]: ContentDetails }): Promise<Item[]> {
  try {
    // Import the pipeline dynamically
    const { pipeline } = await import("@huggingface/transformers");

    // Create the embedding model
    const embed = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

    // Embed the query
    const queryEmbedding = await embed([query], {
      pooling: 'cls',
      normalize: true,
      quantize: true,
      precision: "ubinary"
    });

    const queryEmbeddingUint8 = new Uint8Array(queryEmbedding.tolist()[0]);

    // Calculate distances for all chunks
    const results: Array<{ slug: FullSlug, distance: number, chunk: string }> = [];

    for (const [slug, fileData] of Object.entries<ContentDetails>(data)) {
      if (!fileData.chunkEmbeddings || fileData.chunkEmbeddings.length === 0) continue;

      for (const chunkData of fileData.chunkEmbeddings) {
        try {
          const chunkEmbeddingUint8 = decodeEmbedding(chunkData.embedding);
          const distance = hammingDistance(queryEmbeddingUint8, chunkEmbeddingUint8);

          results.push({
            slug: slug as FullSlug,
            distance,
            chunk: chunkData.content
          });
        } catch (error) {
          console.error(`Error processing embedding for ${slug}:`, error);
        }
      }
    }

    // Sort by distance (smaller is better)
    results.sort((a, b) => a.distance - b.distance);

    // Deduplicate by source document
    const seen = new Set<FullSlug>();
    const deduplicated = results.filter(result => {
      if (seen.has(result.slug)) return false;
      seen.add(result.slug);
      return true;
    });

    // Take top 5
    const topResults = deduplicated.slice(0, 5);

    // Format results for display
    return topResults.map(result => {
      // Get first and last words from the chunk for text fragment
      const words = result.chunk.trim().split(/\s+/);
      if (words.length < 1) return null;

      const firstWords = words.slice(0, Math.min(3, words.length)).join(' ');
      const lastWords = words.length > 3
        ? words.slice(Math.max(words.length - 3, 0)).join(' ')
        : firstWords;

      // Create text fragment with start and end text
      const textFragment = "#:~:text=" +
        encodeURIComponent(firstWords) +
        "," +
        encodeURIComponent(lastWords);

      return {
        id: -1, // Use negative IDs to distinguish from regular search results
        slug: result.slug, // Keep the original slug
        textFragment, // Store fragment separately
        title: data[result.slug].title,
        content: result.chunk, // Keep original content for preview
        tags: data[result.slug].tags,
        distance: result.distance,
        firstWords, // Store for preview highlighting
        lastWords, // Store for preview highlighting
      };
    }).filter(Boolean) as Item[];
  } catch (error) {
    console.error("Error in vector search:", error);
    return [];
  }
}
