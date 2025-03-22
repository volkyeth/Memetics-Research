<!-- QueryToSerialize: TABLE L.text as "Topic" FROM "source/content" FLATTEN file.lists as L WHERE contains(L.tags, "#look-into") -->
<!-- SerializedQuery: TABLE L.text as "Topic" FROM "source/content" FLATTEN file.lists as L WHERE contains(L.tags, "#look-into") -->

| File | Topic |
| ---- | ----- |
<!-- SerializedQuery END -->

<!-- QueryToSerialize: TABLE L.text as "Question" FROM "source/content" FLATTEN file.lists as L WHERE contains(L.tags, "#question") -->
<!-- SerializedQuery: TABLE L.text as "Question" FROM "source/content" FLATTEN file.lists as L WHERE contains(L.tags, "#question") -->

| File | Question |
| ---- | -------- |
<!-- SerializedQuery END -->
