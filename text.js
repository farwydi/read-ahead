(() => {
  const MAX_CHUNK = 200;
  function split(text) {
    const chunks = [];
    const segmenter = new Intl.Segmenter("ru", {granularity: "sentence"});
    for (const part of segmenter.segment(text)) {
      let start = part.index;
      const stop = start + part.segment.length;
      while (start < stop) {
        while (start < stop && /\s/u.test(text[start])) start++;
        if (start === stop) break;
        let end = Math.min(start + MAX_CHUNK, stop);
        if (end < stop) {
          const candidate = text.slice(start, end);
          const breaks = [...candidate.matchAll(/[,;:—]\s|\s/gu)];
          const last = breaks.at(-1);
          if (last && last.index > MAX_CHUNK / 2) end = start + last.index + last[0].length;
          if (/[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
        }
        let trimmedEnd = end;
        while (trimmedEnd > start && /\s/u.test(text[trimmedEnd - 1])) trimmedEnd--;
        const value = text.slice(start, trimmedEnd).replace(/\s+/gu, " ");
        if (/[\p{L}\p{N}]/u.test(value)) chunks.push({text: value, start, end: trimmedEnd});
        start = end;
      }
    }
    return chunks;
  }

  function extract(document, selectionRange) {
    const excluded = "script,style,noscript,svg,canvas,iframe,form,input,textarea,select,button," +
      "[contenteditable]:not([contenteditable=false]),[hidden],[aria-hidden=true],[inert],#read-ahead-panel";
    let root;
    if (selectionRange) {
      root = selectionRange.commonAncestorContainer;
      if (root.nodeType === 3) root = root.parentElement;
    } else {
      // ponytail: семантическая разметка; для сложной ленты пользователь выбирает текст сам.
      root = [...document.querySelectorAll("article,main,[role=main]")]
        .filter(el => el.checkVisibility({checkVisibilityCSS: true}))
        .sort((a, b) => b.innerText.length - a.innerText.length)[0] ?? document.body;
    }
    const spans = [];
    let text = "", previousBlock;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!node.data || parent.closest(excluded) ||
          (!selectionRange && parent.closest("nav,aside,footer,pre,code,[role=navigation],[role=banner]")) ||
          !parent.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) ||
          (selectionRange && !selectionRange.intersectsNode(node))) continue;
      const lo = selectionRange?.startContainer === node ? selectionRange.startOffset : 0;
      const hi = selectionRange?.endContainer === node ? selectionRange.endOffset : node.length;
      if (lo === hi) continue;
      const block = parent.closest("p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,td,th,div,section,article,main");
      if (text && block !== previousBlock) text += "\n\n";
      const start = text.length;
      text += node.data.slice(lo, hi);
      spans.push({node, lo, hi, start, end: text.length});
      previousBlock = block;
    }
    return {chunks: split(text), spans};
  }

  function rangeFor(chunk, spans, document) {
    const first = spans.find(span => span.end > chunk.start);
    const last = spans.findLast(span => span.start < chunk.end);
    if (!first?.node.isConnected || !last?.node.isConnected) return null;
    const range = document.createRange();
    range.setStart(first.node, Math.min(first.node.length, first.lo + Math.max(0, chunk.start - first.start)));
    range.setEnd(last.node, Math.min(last.node.length, last.lo + Math.min(last.hi - last.lo, chunk.end - last.start)));
    return range;
  }
  globalThis.ReadAheadText = {split, extract, rangeFor};
})();
