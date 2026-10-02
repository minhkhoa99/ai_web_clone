"""
Native Playwright Stealth Evading Script
Injects JavaScript evasions to bypass bot detection without external packages.
"""

from playwright.async_api import Page, BrowserContext

STEALTH_JS = """
// 1. Remove navigator.webdriver flag
Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined
});

// 2. Mock window.chrome
window.chrome = {
    runtime: {},
    loadTimes: function() {},
    csi: function() {},
    app: {}
};

// 3. Mock Languages
Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en', 'vi']
});

// 4. Mock Plugins
Object.defineProperty(navigator, 'plugins', {
    get: () => [
        {
            0: {type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format"},
            description: "Portable Document Format",
            filename: "internal-pdf-viewer",
            length: 1,
            name: "Chrome PDF Plugin"
        }
    ]
});

// 5. Override permissions query
const originalQuery = window.navigator.permissions.query;
window.navigator.permissions.query = (parameters) => (
    parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
);

// 6. WebGL Vendor & Renderer spoofing
const getParameter = WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter = function(parameter) {
    // UNMASKED_VENDOR_WEBGL
    if (parameter === 37445) {
        return 'Intel Inc.';
    }
    // UNMASKED_RENDERER_WEBGL
    if (parameter === 37446) {
        return 'Intel(R) Iris(R) Xe Graphics';
    }
    return getParameter.apply(this, arguments);
};
"""

async def apply_stealth(page_or_context: Page | BrowserContext) -> None:
    """Apply stealth evasion script to a Playwright page or context."""
    if hasattr(page_or_context, "add_init_script"):
        await page_or_context.add_init_script(STEALTH_JS)
