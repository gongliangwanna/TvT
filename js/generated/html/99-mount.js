(function () {
    const chunks = window.__OVO_HTML_CHUNKS__;
    const phone = document.querySelector('.phone-screen');
    if (!chunks || !phone) throw new Error('OVO HTML mount point is missing');
    phone.insertAdjacentHTML('beforeend', chunks.phone.join(''));
    document.body.insertAdjacentHTML('beforeend', chunks.body.join(''));
    document.querySelectorAll('script[data-ovo-html-loader]').forEach(script => script.remove());
    delete window.__OVO_HTML_CHUNKS__;
})();
