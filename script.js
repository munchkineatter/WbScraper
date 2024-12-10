class WebScraper {
    constructor() {
        this.urlInput = document.getElementById('urlInput');
        this.scanBtn = document.getElementById('scanBtn');
        this.downloadBtn = document.getElementById('downloadBtn');
        this.linkTree = document.getElementById('linkTree');
        this.progressSection = document.getElementById('progressSection');
        this.progressFill = document.getElementById('progressFill');
        this.progressText = document.getElementById('progressText');
        this.selectAllBtn = document.getElementById('selectAllBtn');
        this.terminal = document.getElementById('terminalOutput');
        this.clearTerminalBtn = document.getElementById('clearTerminal');
        
        this.initializeEventListeners();
        this.scannedPages = new Map(); // Store scanned page content

        // Add CORS proxies array
        this.corsProxies = [
            (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
            (url) => `https://cors-anywhere.herokuapp.com/${url}`,
            (url) => `https://cors.bridged.cc/${url}`,
            (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
        ];
        this.currentProxyIndex = 0;

        // Add configuration for concurrency
        this.maxConcurrentRequests = 10; // Adjust based on target site's limits
        this.batchSize = 50; // Size of batches for concurrent processing

        // Add supported file extensions for binary downloads
        this.binaryExtensions = new Set([
            '.pdf', '.doc', '.docx', '.xls', '.xlsx',
            '.ppt', '.pptx', '.zip', '.rar', '.mp3',
            '.mp4', '.jpg', '.jpeg', '.png', '.gif'
        ]);
    }

    initializeEventListeners() {
        this.scanBtn.addEventListener('click', () => this.scanUrl());
        this.downloadBtn.addEventListener('click', () => this.downloadSelected());
        this.selectAllBtn.addEventListener('click', () => this.toggleSelectAll());
        this.clearTerminalBtn.addEventListener('click', () => this.clearTerminal());
    }

    log(message, type = 'info') {
        const line = document.createElement('div');
        line.className = 'terminal-line';
        
        const timestamp = document.createElement('span');
        timestamp.className = 'terminal-timestamp';
        timestamp.textContent = new Date().toLocaleTimeString();
        
        const text = document.createElement('span');
        text.className = `terminal-message ${type}`;
        text.textContent = message;
        
        line.appendChild(timestamp);
        line.appendChild(text);
        
        this.terminal.appendChild(line);
        this.terminal.scrollTop = this.terminal.scrollHeight;
    }

    clearTerminal() {
        this.terminal.innerHTML = '';
        this.log('Terminal cleared', 'info');
    }

    async scanUrl() {
        try {
            const url = this.urlInput.value;
            if (!url) {
                this.log('Please enter a valid URL', 'error');
                alert('Please enter a valid URL');
                return;
            }

            this.log(`Starting URL discovery scan of: ${url}`, 'info');
            this.progressSection.style.display = 'block';
            this.updateProgress(0, 'Starting URL discovery...');

            const parsedUrl = new URL(url);
            const baseUrl = parsedUrl.origin;
            const basePath = parsedUrl.pathname.replace(/\/+$/, '');
            const allLinks = new Set();
            
            await this.collectUrls(url, allLinks, baseUrl, basePath);

            this.log(`Found ${allLinks.size} links within ${basePath}`, 'success');
            this.updateProgress(80, 'Organizing links...');
            this.log('Organizing links into tree structure...', 'info');
            
            this.displayLinks(Array.from(allLinks));
            
            this.updateProgress(100, 'URL discovery complete!');
            this.log('Select the pages you want to download', 'info');
            
            setTimeout(() => {
                this.progressSection.style.display = 'none';
            }, 1000);

            this.downloadBtn.disabled = false;
            this.selectAllBtn.style.display = 'block';
        } catch (error) {
            console.error('Error scanning URL:', error);
            this.log(`Error scanning URL: ${error.message}`, 'error');
            alert('Error scanning URL. Please make sure the URL is accessible and try again.');
            this.progressSection.style.display = 'none';
        }
    }

    // Add new method for fetching with retry logic
    async fetchWithCORS(url, retries = 3) {
        let lastError;
        
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                // Try each proxy in sequence
                for (let i = 0; i < this.corsProxies.length; i++) {
                    const proxyIndex = (this.currentProxyIndex + i) % this.corsProxies.length;
                    const proxyUrl = this.corsProxies[proxyIndex](url);
                    
                    try {
                        const response = await fetch(proxyUrl);
                        
                        // If successful, update the current proxy index to use this successful proxy first next time
                        this.currentProxyIndex = proxyIndex;
                        
                        // Handle different proxy response formats
                        if (response.ok) {
                            const data = await response.text();
                            try {
                                // Try parsing as JSON (for allorigins format)
                                const jsonData = JSON.parse(data);
                                return jsonData.contents || data;
                            } catch {
                                // If not JSON, return the raw data
                                return data;
                            }
                        }
                    } catch (error) {
                        lastError = error;
                        this.log(`Proxy ${proxyIndex + 1} failed, trying next...`, 'warning');
                        continue;
                    }
                }
                
                // If we get here, all proxies failed on this attempt
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
                
            } catch (error) {
                lastError = error;
                this.log(`Attempt ${attempt + 1} failed, retrying...`, 'warning');
            }
        }
        
        throw new Error(`Failed to fetch after ${retries} attempts: ${lastError.message}`);
    }

    // Update the collectUrls method to properly handle nested link discovery
    async collectUrls(url, allLinks, baseUrl, basePath, depth = 0, maxDepth = 3) {
        if (depth > maxDepth) {
            return;
        }

        try {
            const currentPath = new URL(url).pathname;
            if (!this.isWithinBasePath(currentPath, basePath)) {
                this.log(`Skipping ${url} - Outside target directory`, 'warning');
                return;
            }

            this.log(`Discovering links in: ${url}`, 'info');
            
            // Process URLs in batches
            const pendingUrls = new Set([url]);
            const processedUrls = new Set();

            while (pendingUrls.size > 0) {
                // Take a batch of URLs to process
                const batch = Array.from(pendingUrls).slice(0, this.batchSize);
                batch.forEach(url => pendingUrls.delete(url));
                const newBatch = batch.filter(url => !processedUrls.has(url));
                
                if (newBatch.length === 0) continue;

                // Process batch concurrently
                const promises = newBatch.map(async (batchUrl) => {
                    try {
                        if (processedUrls.has(batchUrl)) return;
                        
                        // Check if it's a binary file
                        const isBinary = this.isBinaryFile(batchUrl);
                        if (isBinary) {
                            processedUrls.add(batchUrl);
                            allLinks.add(batchUrl);
                            return;
                        }

                        const html = await this.fetchWithCORS(batchUrl);
                        processedUrls.add(batchUrl);
                        allLinks.add(batchUrl);

                        // Enhanced URL discovery to include file links
                        const urlMatches = html.match(/(?:href|src)=["'](.*?)["']/g) || [];
                        const newUrls = urlMatches
                            .map(match => {
                                try {
                                    const href = match.match(/(?:href|src)=["'](.*?)["']/)[1];
                                    const fullUrl = new URL(href, batchUrl).href;
                                    if (fullUrl.startsWith(baseUrl)) {
                                        const hrefPath = new URL(fullUrl).pathname;
                                        if (this.isWithinBasePath(hrefPath, basePath)) {
                                            return fullUrl;
                                        }
                                    }
                                    return null;
                                } catch {
                                    return null;
                                }
                            })
                            .filter(url => url && 
                                !processedUrls.has(url) && 
                                !Array.from(pendingUrls).includes(url)
                            );

                        // Add new URLs to pending set
                        newUrls.forEach(url => pendingUrls.add(url));
                        
                        const totalUrls = processedUrls.size + pendingUrls.size;
                        const progress = (processedUrls.size / totalUrls) * 70;
                        this.updateProgress(progress, `Discovered ${allLinks.size} links...`);
                        this.log(`Found ${newUrls.length} new links on ${batchUrl}`, 'info');
                    } catch (error) {
                        this.log(`Error processing ${batchUrl}: ${error.message}`, 'warning');
                    }
                });

                // Process batch with concurrency limit
                for (let i = 0; i < newBatch.length; i += this.maxConcurrentRequests) {
                    const batchPromises = promises.slice(i, i + this.maxConcurrentRequests);
                    await Promise.all(batchPromises);
                }
            }
        } catch (error) {
            this.log(`Error discovering links: ${error.message}`, 'warning');
        }
    }

    updateProgress(percentage, message) {
        this.progressFill.style.width = `${percentage}%`;
        this.progressText.textContent = message;
    }

    displayLinks(links) {
        this.linkTree.innerHTML = '';
        
        const tree = this.organizeLinksIntoTree(links);
        this.renderTree(tree, this.linkTree);
    }

    organizeLinksIntoTree(links) {
        const tree = {};
        
        links.forEach(link => {
            try {
                const url = new URL(link);
                const parts = url.pathname.split('/').filter(p => p);
                let current = tree;
                
                if (parts.length === 0) {
                    current['index'] = current['index'] || {};
                    current['index']._url = link;
                } else {
                    parts.forEach((part, index) => {
                        current[part] = current[part] || {};
                        current = current[part];
                        
                        if (index === parts.length - 1) {
                            current._url = link;
                        }
                    });
                }
            } catch (error) {
                console.error('Error organizing link:', link, error);
            }
        });
        
        return tree;
    }

    renderTree(tree, container, level = 0) {
        Object.entries(tree).forEach(([key, value]) => {
            if (key === '_url') return;
            
            const item = document.createElement('div');
            item.className = 'tree-item';
            
            const label = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            
            if (value._url) {
                checkbox.setAttribute('data-url', value._url);
            }
            
            checkbox.addEventListener('change', (e) => {
                const checked = e.target.checked;
                const nestedCheckboxes = item.querySelectorAll('input[type="checkbox"]');
                nestedCheckboxes.forEach(cb => {
                    cb.checked = checked;
                    if (checked && cb.getAttribute('data-url')) {
                        cb.setAttribute('data-selected', 'true');
                    } else {
                        cb.removeAttribute('data-selected');
                    }
                });
                
                this.updateParentCheckboxes(checkbox);
            });
            
            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(key));
            item.appendChild(label);
            
            if (Object.keys(value).length > 0) {
                const nested = document.createElement('div');
                nested.className = 'nested';
                this.renderTree(value, nested, level + 1);
                item.appendChild(nested);
            }
            
            container.appendChild(item);
        });
    }

    updateParentCheckboxes(checkbox) {
        let parent = checkbox.closest('.nested')?.parentElement;
        while (parent) {
            const parentCheckbox = parent.querySelector('input[type="checkbox"]');
            if (!parentCheckbox) break;

            const siblings = parent.querySelector('.nested')?.querySelectorAll('input[type="checkbox"]');
            if (!siblings) break;

            const siblingsArray = Array.from(siblings);
            const allChecked = siblingsArray.every(cb => cb.checked);
            const someChecked = siblingsArray.some(cb => cb.checked);

            parentCheckbox.checked = allChecked;
            parentCheckbox.indeterminate = !allChecked && someChecked;

            parent = parent.closest('.nested')?.parentElement;
        }
    }

    toggleSelectAll() {
        const allCheckboxes = this.linkTree.querySelectorAll('input[type="checkbox"]');
        const allChecked = Array.from(allCheckboxes).every(cb => cb.checked);
        allCheckboxes.forEach(cb => {
            cb.checked = !allChecked;
            cb.indeterminate = false;
        });
    }

    // Add this new method to generate unique filenames
    generateUniqueFilename(url) {
        try {
            const urlObj = new URL(url);
            const pathParts = urlObj.pathname.replace(/^\/|\/$/g, '').split('/');
            
            if (pathParts.length === 0 || (pathParts.length === 1 && pathParts[0] === '')) {
                return 'index.html';
            }

            // Get the original filename
            let filename = pathParts[pathParts.length - 1];
            
            // If filename is empty or doesn't have an extension
            if (!filename || !filename.includes('.')) {
                filename = pathParts.join('_') + '.html';
            }

            // Replace any remaining special characters while preserving the extension
            const [name, ext] = filename.split('.');
            const sanitizedName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
            return `${sanitizedName}.${ext}`;
        } catch (error) {
            console.error('Error generating filename:', error);
            return `page_${Math.random().toString(36).substr(2, 9)}.html`;
        }
    }

    // Update the downloadSelected method to use concurrent downloads
    async downloadSelected() {
        const zip = new JSZip();
        const selected = this.getSelectedUrls();
        
        if (selected.length === 0) {
            this.log('No pages selected for download', 'warning');
            alert('Please select at least one page to download');
            return;
        }

        try {
            this.log(`Starting download of ${selected.length} pages...`, 'info');
            this.progressSection.style.display = 'block';
            this.updateProgress(0, 'Starting download...');

            const filenameCount = new Map();
            let completedDownloads = 0;

            // Process downloads in batches
            for (let i = 0; i < selected.length; i += this.batchSize) {
                const batch = selected.slice(i, i + this.batchSize);
                const downloadPromises = batch.map(async (url) => {
                    try {
                        const isBinary = this.isBinaryFile(url);
                        let content;
                        
                        if (isBinary) {
                            // Fetch binary content
                            const response = await fetch(url);
                            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                            content = await response.blob();
                        } else {
                            // Fetch HTML content
                            content = await this.fetchWithCORS(url);
                        }

                        // Generate filename based on URL and content type
                        let filename = this.generateUniqueFilename(url);
                        
                        if (filenameCount.has(filename)) {
                            const count = filenameCount.get(filename) + 1;
                            filenameCount.set(filename, count);
                            const nameParts = filename.split('.');
                            filename = `${nameParts[0]}_${count}.${nameParts[1]}`;
                        } else {
                            filenameCount.set(filename, 1);
                        }
                        
                        zip.file(filename, content);
                        completedDownloads++;
                        
                        const progress = Math.round((completedDownloads / selected.length) * 90);
                        this.updateProgress(progress, `Downloaded ${completedDownloads} of ${selected.length} files...`);
                        this.log(`Downloaded: ${url} → ${filename}`, 'success');
                    } catch (error) {
                        this.log(`Failed to download ${url}: ${error.message}`, 'error');
                    }
                });

                // Process batch with concurrency limit
                for (let j = 0; j < batch.length; j += this.maxConcurrentRequests) {
                    const batchPromises = downloadPromises.slice(j, j + this.maxConcurrentRequests);
                    await Promise.all(batchPromises);
                }
            }

            // Create and download ZIP file
            this.updateProgress(95, 'Creating ZIP file...');
            const content = await zip.generateAsync({type: 'blob'});
            
            this.updateProgress(100, 'Download ready!');
            this.log('ZIP file created successfully!', 'success');
            
            const downloadUrl = URL.createObjectURL(content);
            const link = document.createElement('a');
            link.href = downloadUrl;
            link.download = 'scraped-pages.zip';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(downloadUrl);
            
            this.log('Download started!', 'success');

            setTimeout(() => {
                this.progressSection.style.display = 'none';
            }, 1000);
        } catch (error) {
            console.error('Error downloading pages:', error);
            this.log(`Error downloading pages: ${error.message}`, 'error');
            alert('Error downloading pages. Please try again.');
            this.progressSection.style.display = 'none';
        }
    }

    getSelectedUrls() {
        const selected = [];
        const checkboxes = this.linkTree.querySelectorAll('input[type="checkbox"]:checked');
        
        checkboxes.forEach(checkbox => {
            const url = checkbox.getAttribute('data-url');
            if (url) {
                selected.push(url);
            }
        });
        
        console.log('Selected URLs:', selected);
        return selected;
    }

    // Add new method to check if a path is within the base path
    isWithinBasePath(currentPath, basePath) {
        // Normalize paths by removing trailing slashes and converting to lowercase
        const normalizedCurrent = currentPath.toLowerCase().replace(/\/+$/, '');
        const normalizedBase = basePath.toLowerCase().replace(/\/+$/, '');
        
        // Check if the current path starts with the base path
        if (!normalizedCurrent.startsWith(normalizedBase)) {
            return false;
        }
        
        // If the current path is longer than the base path, make sure it doesn't go up in the hierarchy
        if (normalizedCurrent.length > normalizedBase.length) {
            const remainingPath = normalizedCurrent.slice(normalizedBase.length);
            // Check if the remaining path tries to go up in the hierarchy
            if (remainingPath.includes('../') || remainingPath.includes('/..')) {
                return false;
            }
        }
        
        return true;
    }

    // Add method to check if URL is a binary file
    isBinaryFile(url) {
        try {
            const extension = url.toLowerCase().split('.').pop();
            return this.binaryExtensions.has(`.${extension}`);
        } catch {
            return false;
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new WebScraper();
}); 