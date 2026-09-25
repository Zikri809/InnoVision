async function initSearch(inputId, resultId) {
  const input = document.getElementById(inputId);
  const results = document.getElementById(resultId);
  if (!input || !results) return;

  let entries = [];
  try {
    const response = await fetch("search-index.json");
    if (!response.ok) throw new Error("Search index unavailable");
    entries = await response.json();
  } catch {
    results.hidden = false;
    results.textContent = "Search is unavailable here. Use the manual sections or your browser's Find command.";
    return;
  }

  const render = () => {
    const query = input.value.trim().toLocaleLowerCase();
    results.replaceChildren();
    if (!query) {
      results.hidden = true;
      return;
    }

    const matches = entries.filter((entry) =>
      `${entry.title} ${entry.page} ${entry.text}`.toLocaleLowerCase().includes(query)
    ).slice(0, 10);
    results.hidden = false;
    if (!matches.length) {
      results.textContent = "No matching section. Try a shorter term such as camera, join, results, or export.";
      return;
    }

    for (const entry of matches) {
      const link = document.createElement("a");
      link.href = entry.url;
      link.textContent = entry.title;
      const context = document.createElement("small");
      context.textContent = entry.page;
      link.append(context);
      results.append(link);
    }
  };
  input.addEventListener("input", render);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      input.value = "";
      render();
    }
  });
}

initSearch("manual-search", "search-results");
initSearch("manual-search-mobile", "mobile-search-results");

function initPageContents() {
  const headings = [...document.querySelectorAll("article h2[id], article h3[id]")];
  const links = [...document.querySelectorAll(".on-page nav a, .page-toc nav a")];
  if (!headings.length || !links.length) return;

  let pending = false;
  const update = () => {
    pending = false;
    let active = headings[0];
    for (const heading of headings) {
      if (heading.getBoundingClientRect().top <= 170) active = heading;
      else break;
    }
    for (const link of links) {
      if (link.hash === `#${active.id}`) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  };
  window.addEventListener("scroll", () => {
    if (!pending) {
      pending = true;
      requestAnimationFrame(update);
    }
  }, { passive: true });
  window.addEventListener("hashchange", update);
  update();

  const menu = document.querySelector(".page-toc");
  for (const link of document.querySelectorAll(".page-toc nav a")) {
    link.addEventListener("click", () => { if (menu) menu.open = false; });
  }
}

initPageContents();
