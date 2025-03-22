##### 🌺 Flowers (Largest Entries)
<!-- QueryToSerialize: TABLE dateformat(file.mtime, "dd.MM.yyyy - HH:mm") AS "Last Modified", round(file.size / 5) AS "Est. Words" FROM "source/content" WHERE file.size > 0 SORT file.size DESC LIMIT 10 -->
<!-- SerializedQuery: TABLE dateformat(file.mtime, "dd.MM.yyyy - HH:mm") AS "Last Modified", round(file.size / 5) AS "Est. Words" FROM "source/content" WHERE file.size > 0 SORT file.size DESC LIMIT 10 -->

| File | Last Modified | Est. Words |
| ---- | ------------- | ---------- |
<!-- SerializedQuery END -->

#### 🌦️ Weather (Most Recent Entries)
<!-- QueryToSerialize: TABLE dateformat(file.mtime, "dd.MM.yyyy - HH:mm") AS "Last Modified" FROM "source/content" WHERE file.size = 0 SORT file.mtime DESC -->
<!-- SerializedQuery: TABLE dateformat(file.mtime, "dd.MM.yyyy - HH:mm") AS "Last Modified" FROM "source/content" WHERE file.size = 0 SORT file.mtime DESC -->

| File | Last Modified |
| ---- | ------------- |
<!-- SerializedQuery END -->

#### 🌰 Seeds (Empty Entries)
<!-- QueryToSerialize: TABLE dateformat(file.mtime, "dd.MM.yyyy - HH:mm") AS "Last Modified" FROM "source/content" WHERE file.size = 0 SORT file.mtime DESC -->
<!-- SerializedQuery: TABLE dateformat(file.mtime, "dd.MM.yyyy - HH:mm") AS "Last Modified" FROM "source/content" WHERE file.size = 0 SORT file.mtime DESC -->

| File | Last Modified |
| ---- | ------------- |
<!-- SerializedQuery END -->
