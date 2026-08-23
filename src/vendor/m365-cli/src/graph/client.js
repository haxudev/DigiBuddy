import { getAccessToken } from '../auth/token-manager.js';
import config from '../utils/config.js';
import { ApiError, parseGraphError } from '../utils/error.js';

/**
 * Microsoft Graph API Client
 * Handles HTTP requests with automatic token refresh
 */

class GraphClient {
  constructor() {
    this.baseUrl = config.get('graphApiUrl');
  }

  /**
   * Make authenticated request
   */
  async request(endpoint, options = {}) {
    const {
      method = 'GET',
      body = null,
      headers = {},
      queryParams = {},
    } = options;

    // Get access token (auto-refresh if needed)
    const token = await getAccessToken();

    // Build URL with query parameters
    let url = `${this.baseUrl}${endpoint}`;
    if (Object.keys(queryParams).length > 0) {
      const params = new URLSearchParams(queryParams);
      url += `?${params.toString()}`;
    }

    // Build request headers
    const requestHeaders = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...headers,
    };

    // Build request options
    const requestOptions = {
      method,
      headers: requestHeaders,
    };

    if (body && method !== 'GET') {
      requestOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    // Make request
    try {
      const response = await fetch(url, requestOptions);

      // Handle empty responses (204, etc.)
      if (response.status === 204) {
        return { success: true };
      }

      // Parse JSON response
      const data = await response.json().catch(() => ({}));

      // Handle errors
      if (!response.ok) {
        throw parseGraphError(data, response.status);
      }

      return data;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError(`Request failed: ${error.message}`, 0);
    }
  }

  /**
   * GET request
   */
  async get(endpoint, options = {}) {
    return this.request(endpoint, { ...options, method: 'GET' });
  }

  /**
   * POST request
   */
  async post(endpoint, body, options = {}) {
    return this.request(endpoint, { ...options, method: 'POST', body });
  }

  /**
   * PATCH request
   */
  async patch(endpoint, body, options = {}) {
    return this.request(endpoint, { ...options, method: 'PATCH', body });
  }

  /**
   * DELETE request
   */
  async delete(endpoint, options = {}) {
    return this.request(endpoint, { ...options, method: 'DELETE' });
  }

  /**
   * Mail endpoints
   */
  mail = {
    /**
     * Map friendly folder names to Graph API well-known folder names
     */
    _mapFolderName: (folder) => {
      const folderMap = {
        'inbox': 'inbox',
        'sent': 'sentitems',
        'drafts': 'drafts',
        'deleted': 'deleteditems',
        'junk': 'junkemail',
        'archive': 'archive',
      };

      // Convert to lowercase for case-insensitive matching
      const lowerFolder = folder.toLowerCase();

      // Return mapped name if found, otherwise return original (for direct IDs)
      return folderMap[lowerFolder] || folder;
    },

    /**
     * List messages
     */
    list: async (options = {}) => {
      const { top = 10, folder = 'inbox', select, orderby } = options;

      const queryParams = {
        '$top': top,
      };

      if (select) {
        queryParams['$select'] = Array.isArray(select) ? select.join(',') : select;
      } else {
        queryParams['$select'] = 'id,subject,from,receivedDateTime,isRead,hasAttachments';
      }

      if (orderby) {
        queryParams['$orderby'] = orderby;
      } else {
        queryParams['$orderby'] = 'receivedDateTime desc';
      }

      // Map friendly folder names to Graph API names
      const mappedFolder = this.mail._mapFolderName(folder);

      // Always scope to the specific folder so inbox doesn't return sent items etc.
      let endpoint = `/me/mailFolders/${mappedFolder}/messages`;

      const response = await this.get(endpoint, { queryParams });
      return response.value || [];
    },

    /**
     * Get message by ID
     */
    get: async (id, options = {}) => {
      const { select, expand } = options;

      const queryParams = {};
      if (select) {
        queryParams['$select'] = Array.isArray(select) ? select.join(',') : select;
      }

      // Always expand attachments to get attachment info
      if (expand !== false) {
        queryParams['$expand'] = 'attachments';
      }

      return this.get(`/me/messages/${id}`, { queryParams });
    },

    /**
     * Send message
     */
    send: async (message) => {
      const payload = {
        message,
        saveToSentItems: true,
      };

      return this.post('/me/sendMail', payload);
    },

    /**
     * Search messages
     */
    search: async (query, options = {}) => {
      const { top = 10 } = options;

      const queryParams = {
        '$search': `"${query}"`,
        '$top': top,
        '$select': 'id,subject,from,receivedDateTime,isRead,hasAttachments',
        // Note: $orderby not supported with $search
      };

      const response = await this.get('/me/messages', {
        queryParams,
        headers: {
          'ConsistencyLevel': 'eventual',
        },
      });

      return response.value || [];
    },

    /**
     * List attachments for a message
     */
    attachments: async (id) => {
      const response = await this.get(`/me/messages/${id}/attachments`, {
        queryParams: {
          '$select': 'id,name,size,contentType',
        },
      });

      return response.value || [];
    },

    /**
     * Download a specific attachment
     */
    downloadAttachment: async (messageId, attachmentId) => {
      return this.get(`/me/messages/${messageId}/attachments/${attachmentId}`);
    },
  };

  /**
   * Calendar endpoints
   */
  calendar = {
    /**
     * List calendar events in a time range
     */
    list: async (options = {}) => {
      const { startDateTime, endDateTime, top = 50, select, orderby } = options;

      if (!startDateTime || !endDateTime) {
        throw new Error('startDateTime and endDateTime are required');
      }

      const queryParams = {
        'startDateTime': startDateTime,
        'endDateTime': endDateTime,
        '$top': top,
      };

      if (select) {
        queryParams['$select'] = Array.isArray(select) ? select.join(',') : select;
      } else {
        queryParams['$select'] = 'id,subject,start,end,location,isAllDay,bodyPreview';
      }

      if (orderby) {
        queryParams['$orderby'] = orderby;
      } else {
        queryParams['$orderby'] = 'start/dateTime';
      }

      const response = await this.get('/me/calendarView', {
        queryParams,
        headers: {
          'Prefer': 'outlook.timezone="Asia/Shanghai"',
        },
      });

      return response.value || [];
    },

    /**
     * Get calendar event by ID
     */
    get: async (id, options = {}) => {
      const { select } = options;

      const queryParams = {};
      if (select) {
        queryParams['$select'] = Array.isArray(select) ? select.join(',') : select;
      }

      return this.get(`/me/events/${id}`, {
        queryParams,
        headers: {
          'Prefer': 'outlook.timezone="Asia/Shanghai"',
        },
      });
    },

    /**
     * Create calendar event
     */
    create: async (event) => {
      return this.post('/me/events', event, {
        headers: {
          'Prefer': 'outlook.timezone="Asia/Shanghai"',
        },
      });
    },

    /**
     * Update calendar event
     */
    update: async (id, updates) => {
      return this.patch(`/me/events/${id}`, updates, {
        headers: {
          'Prefer': 'outlook.timezone="Asia/Shanghai"',
        },
      });
    },

    /**
     * Delete calendar event
     */
    delete: async (id) => {
      return this.delete(`/me/events/${id}`);
    },
  };

  /**
   * SharePoint endpoints
   */
  sharepoint = {
    /**
     * Parse site URL or ID to get site-id
     * Supports three formats:
     * 1. Graph API ID: "hostname,siteId,webId"
     * 2. Site URL: "hostname:/sites/team"
     * 3. Short path: "/sites/team" (auto-completes hostname)
     */
    _parseSite: async (site) => {
      // Format 1: Graph API ID (hostname,guid,guid)
      // Example: "contoso.sharepoint.com,8bfb5166-...,ea772c4f-..."
      if (site.includes(',')) {
        return site;
      }

      // Format 2: Site URL with explicit hostname
      // Example: "contoso.sharepoint.com:/sites/team"
      if (site.includes(':/')) {
        const match = site.match(/^(.+?):\/(.*)/);
        if (!match) {
          throw new Error('Invalid site URL format. Use "hostname:/path"');
        }

        const [, hostname, path] = match;
        const endpoint = `/sites/${hostname}:/${path}`;

        const result = await this.get(endpoint, {
          queryParams: {
            '$select': 'id,name,webUrl',
          },
        });

        return result.id;
      }

      // Format 3: Short path (needs hostname lookup)
      // Example: "/sites/team"
      if (site.startsWith('/')) {
        // Get user's SharePoint hostname from profile
        const profile = await this.get('/me', {
          queryParams: {
            '$select': 'mail',
          },
        });

        // Extract tenant from email (e.g., user@contoso.onmicrosoft.com)
        const email = profile.mail;
        if (!email) {
          throw new Error('Cannot determine SharePoint hostname. Use full format: "hostname:/path"');
        }

        // Extract domain and build SharePoint hostname
        const domain = email.split('@')[1];
        let hostname;

        if (domain.endsWith('.onmicrosoft.com')) {
          // Convert tenant.onmicrosoft.com to tenant.sharepoint.com
          const tenant = domain.replace('.onmicrosoft.com', '');
          hostname = `${tenant}.sharepoint.com`;
        } else {
          // Custom domain - try standard SharePoint hostname
          const orgName = domain.split('.')[0];
          hostname = `${orgName}.sharepoint.com`;
        }

        // Resolve the site
        const endpoint = `/sites/${hostname}:${site}`;

        const result = await this.get(endpoint, {
          queryParams: {
            '$select': 'id,name,webUrl',
          },
        });

        return result.id;
      }

      // Otherwise, assume it's a plain GUID or direct site ID
      return site;
    },

    /**
     * List accessible sites
     */
    sites: async (options = {}) => {
      const { search, top = 50 } = options;

      let endpoint;
      let queryParams = {
        '$top': top,
        '$select': 'id,name,displayName,webUrl,description',
      };

      if (search) {
        // Search sites
        endpoint = '/sites';
        queryParams['$search'] = `"${search}"`;

        const response = await this.get(endpoint, {
          queryParams,
          headers: {
            'ConsistencyLevel': 'eventual',
          },
        });
        return response.value || [];
      } else {
        // List followed sites
        endpoint = '/me/followedSites';
        const response = await this.get(endpoint, { queryParams });
        return response.value || [];
      }
    },

    /**
     * List site lists and document libraries
     */
    lists: async (site, options = {}) => {
      const { top = 100 } = options;

      const siteId = await this.sharepoint._parseSite(site);

      const queryParams = {
        '$top': top,
        '$select': 'id,name,displayName,description,webUrl,list',
      };

      const response = await this.get(`/sites/${siteId}/lists`, { queryParams });
      return response.value || [];
    },

    /**
     * List items in a list
     */
    items: async (site, listId, options = {}) => {
      const { top = 100 } = options;

      const siteId = await this.sharepoint._parseSite(site);

      const queryParams = {
        '$top': top,
        '$expand': 'fields',
      };

      const response = await this.get(`/sites/${siteId}/lists/${listId}/items`, { queryParams });
      return response.value || [];
    },

    /**
     * List files in site default document library
     */
    files: async (site, path = '', options = {}) => {
      const { top = 100 } = options;

      const siteId = await this.sharepoint._parseSite(site);

      let endpoint;
      if (!path || path === '/' || path === '') {
        endpoint = `/sites/${siteId}/drive/root/children`;
      } else {
        const cleanPath = path.replace(/^\/+|\/+$/g, '');
        endpoint = `/sites/${siteId}/drive/root:/${cleanPath}:/children`;
      }

      const queryParams = {
        '$top': top,
        '$select': 'id,name,size,file,folder,lastModifiedDateTime,webUrl',
      };

      const response = await this.get(endpoint, { queryParams });
      return response.value || [];
    },

    /**
     * Download file from SharePoint
     */
    download: async (site, path) => {
      const siteId = await this.sharepoint._parseSite(site);
      const cleanPath = path.replace(/^\/+|\/+$/g, '');
      const endpoint = `/sites/${siteId}/drive/root:/${cleanPath}:/content`;

      // Get access token
      const token = await getAccessToken();

      // Make direct fetch request to get binary content
      const url = `${this.baseUrl}${endpoint}`;
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw parseGraphError(data, response.status);
      }

      return response;
    },

    /**
     * Upload file to SharePoint (small files < 4MB)
     */
    upload: async (site, path, content, options = {}) => {
      const { contentType = 'application/octet-stream' } = options;
      const siteId = await this.sharepoint._parseSite(site);
      const cleanPath = path.replace(/^\/+|\/+$/g, '');
      const endpoint = `/sites/${siteId}/drive/root:/${cleanPath}:/content`;

      // Get access token
      const token = await getAccessToken();

      // Make direct fetch request to send binary content
      const url = `${this.baseUrl}${endpoint}`;
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': contentType,
        },
        body: content,
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw parseGraphError(data, response.status);
      }

      return response.json();
    },

    /**
     * Create upload session for large files
     */
    createUploadSession: async (site, path) => {
      const siteId = await this.sharepoint._parseSite(site);
      const cleanPath = path.replace(/^\/+|\/+$/g, '');
      const endpoint = `/sites/${siteId}/drive/root:/${cleanPath}:/createUploadSession`;

      return this.post(endpoint, {
        item: {
          '@microsoft.graph.conflictBehavior': 'rename',
        },
      });
    },

    /**
     * Search SharePoint content
     */
    search: async (query, options = {}) => {
      const { top = 50 } = options;

      const payload = {
        requests: [
          {
            entityTypes: ['driveItem', 'listItem', 'site'],
            query: {
              queryString: query,
            },
            from: 0,
            size: top,
          },
        ],
      };

      const response = await this.post('/search/query', payload);

      // Extract hits from response
      const hits = response.value?.[0]?.hitsContainers?.[0]?.hits || [];
      return hits.map(hit => hit.resource);
    },
  };

  /**
   * OneDrive endpoints
   */
  onedrive = {
    /**
     * Build path for OneDrive item
     */
    _buildPath: (path) => {
      if (!path || path === '/' || path === '') {
        return '/me/drive/root/children';
      }
      // Remove leading/trailing slashes
      const cleanPath = path.replace(/^\/+|\/+$/g, '');
      return `/me/drive/root:/${cleanPath}:`;
    },

    /**
     * List files and folders
     */
    list: async (path = '', options = {}) => {
      const { top = 100, select } = options;

      let endpoint;
      if (!path || path === '/' || path === '') {
        endpoint = '/me/drive/root/children';
      } else {
        const cleanPath = path.replace(/^\/+|\/+$/g, '');
        endpoint = `/me/drive/root:/${cleanPath}:/children`;
      }

      const queryParams = {
        '$top': top,
      };

      if (select) {
        queryParams['$select'] = Array.isArray(select) ? select.join(',') : select;
      } else {
        queryParams['$select'] = 'id,name,size,file,folder,lastModifiedDateTime,webUrl';
      }

      const response = await this.get(endpoint, { queryParams });
      return response.value || [];
    },

    /**
     * Get item metadata
     */
    getMetadata: async (path, options = {}) => {
      const { select } = options;

      let endpoint;
      if (!path || path === '/' || path === '') {
        endpoint = '/me/drive/root';
      } else {
        const cleanPath = path.replace(/^\/+|\/+$/g, '');
        endpoint = `/me/drive/root:/${cleanPath}`;
      }

      const queryParams = {};
      if (select) {
        queryParams['$select'] = Array.isArray(select) ? select.join(',') : select;
      }

      return this.get(endpoint, { queryParams });
    },

    /**
     * Download file content
     */
    download: async (path) => {
      const cleanPath = path.replace(/^\/+|\/+$/g, '');
      const endpoint = `/me/drive/root:/${cleanPath}:/content`;

      // Get access token
      const token = await getAccessToken();

      // Make direct fetch request to get binary content
      const url = `${this.baseUrl}${endpoint}`;
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw parseGraphError(data, response.status);
      }

      return response;
    },

    /**
     * Upload file (small files < 4MB)
     */
    upload: async (path, content, options = {}) => {
      const { contentType = 'application/octet-stream' } = options;
      const cleanPath = path.replace(/^\/+|\/+$/g, '');
      const endpoint = `/me/drive/root:/${cleanPath}:/content`;

      // Get access token
      const token = await getAccessToken();

      // Make direct fetch request to send binary content
      const url = `${this.baseUrl}${endpoint}`;
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': contentType,
        },
        body: content,
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw parseGraphError(data, response.status);
      }

      return response.json();
    },

    /**
     * Create upload session for large files
     */
    createUploadSession: async (path) => {
      const cleanPath = path.replace(/^\/+|\/+$/g, '');
      const endpoint = `/me/drive/root:/${cleanPath}:/createUploadSession`;

      return this.post(endpoint, {
        item: {
          '@microsoft.graph.conflictBehavior': 'rename',
        },
      });
    },

    /**
     * Upload chunk to session
     */
    uploadChunk: async (uploadUrl, chunk, start, end, totalSize) => {
      const response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': chunk.length.toString(),
          'Content-Range': `bytes ${start}-${end - 1}/${totalSize}`,
        },
        body: chunk,
      });

      if (!response.ok && response.status !== 202) {
        const data = await response.json().catch(() => ({}));
        throw parseGraphError(data, response.status);
      }

      return response.json().catch(() => ({ status: response.status }));
    },

    /**
     * Search files
     */
    search: async (query, options = {}) => {
      const { top = 50 } = options;

      const queryParams = {
        '$top': top,
        '$select': 'id,name,size,file,folder,lastModifiedDateTime,webUrl',
      };

      const endpoint = `/me/drive/root/search(q='${encodeURIComponent(query)}')`;
      const response = await this.get(endpoint, { queryParams });
      return response.value || [];
    },

    /**
     * Create sharing link
     */
    share: async (path, options = {}) => {
      const { type = 'view', scope = 'organization' } = options;

      const cleanPath = path.replace(/^\/+|\/+$/g, '');
      const endpoint = `/me/drive/root:/${cleanPath}:/createLink`;

      return this.post(endpoint, {
        type,
        scope,
      });
    },

    /**
     * Create folder
     */
    mkdir: async (path) => {
      const parts = path.split('/').filter(p => p);
      const folderName = parts.pop();
      const parentPath = parts.join('/');

      let endpoint;
      if (!parentPath) {
        endpoint = '/me/drive/root/children';
      } else {
        endpoint = `/me/drive/root:/${parentPath}:/children`;
      }

      return this.post(endpoint, {
        name: folderName,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail',
      });
    },

    /**
     * Delete file or folder
     */
    remove: async (path) => {
      const cleanPath = path.replace(/^\/+|\/+$/g, '');
      const endpoint = `/me/drive/root:/${cleanPath}`;

      return this.delete(endpoint);
    },

    /**
     * Invite users to access file (external sharing)
     */
    invite: async (path, options = {}) => {
      const {
        recipients = [],
        role = 'read',
        message = '',
        sendInvitation = true,
        requireSignIn = false,
      } = options;

      if (!recipients || recipients.length === 0) {
        throw new Error('At least one recipient email is required');
      }

      // Get item ID first
      const cleanPath = path.replace(/^\/+|\/+$/g, '');
      const itemEndpoint = `/me/drive/root:/${cleanPath}`;
      const item = await this.get(itemEndpoint, {
        queryParams: { '$select': 'id,name' },
      });

      // Prepare recipients array
      const recipientsList = recipients.map(email => ({
        email: typeof email === 'string' ? email : email.email,
      }));

      // Call invite API
      const inviteEndpoint = `/me/drive/items/${item.id}/invite`;
      const payload = {
        requireSignIn,
        sendInvitation,
        roles: [role],
        recipients: recipientsList,
      };

      // Add message if provided
      if (message) {
        payload.message = message;
      }

      return this.post(inviteEndpoint, payload);
    },
  };
}

// Export singleton instance
const graphClient = new GraphClient();
export default graphClient;