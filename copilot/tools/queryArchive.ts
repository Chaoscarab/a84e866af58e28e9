async function queryArchive(page: string) {
    const title = encodeURIComponent(page.trim());
    const response = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${title}`);
    let data = await response.json();
    return data;
}

export { queryArchive };