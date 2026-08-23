---
name: azure-pricing
description: Fetches real-time Azure retail pricing using the Azure Retail Prices API (prices.azure.com). Use when the user asks about the cost of any Azure service, wants to compare SKU prices, or needs pricing data for a cost estimate. Covers compute, storage, networking, databases, AI, and all other Azure service families.
compatibility: Requires internet access to prices.azure.com. No authentication needed.
metadata:
  author: anthonychu
  version: "1.0"
---

# Azure Pricing Skill

Use this skill to retrieve real-time Azure retail pricing data from the public Azure Retail Prices API. No authentication is required.

## API Endpoint

```
GET https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview
```

Append `$filter` as a query parameter using OData filter syntax. Always use `api-version=2023-01-01-preview` to ensure savings plan data is included.

## Step-by-step Instructions

If anything is unclear about the user's request, ask clarifying questions to identify the correct filter fields and values before calling the API.

1. **Identify filter fields** from the user's request (service name, region, SKU, price type).
2. **Resolve the region**: the API requires `armRegionName` values in lowercase with no spaces (e.g. "East US" → `eastus`, "West Europe" → `westeurope`, "Southeast Asia" → `southeastasia`). Derive this from the user's input.
3. **Build the filter string** using the fields below and fetch the URL.
4. **Parse the `Items` array** from the JSON response. Each item contains price and metadata.
5. **Follow pagination** via `NextPageLink` if you need more than the first 1000 results (rarely needed).
6. **ALWAYS pass unit prices** to the `cost_estimator` tool to produce monthly/annual estimates.

## Filterable Fields

| Field | Type | Example |
|---|---|---|
| `serviceName` | string (exact, case-sensitive) | `'Azure Functions'`, `'Virtual Machines'`, `'Azure Blob Storage'` |
| `serviceFamily` | string (exact, case-sensitive) | `'Compute'`, `'Storage'`, `'Databases'`, `'AI + Machine Learning'` |
| `armRegionName` | string (exact, lowercase) | `'eastus'`, `'westeurope'`, `'southeastasia'` |
| `armSkuName` | string (exact) | `'Standard_D4s_v5'`, `'Standard_LRS'` |
| `skuName` | string (contains supported) | `'D4s v5'` |
| `priceType` | string | `'Consumption'`, `'Reservation'`, `'DevTestConsumption'` |
| `meterName` | string (contains supported) | `'Spot'` |

Use `eq` for equality, `and` to combine, and `contains(field, 'value')` for partial matches.

## Example Filter Strings

```
# All consumption prices for Azure Functions in East US
serviceName eq 'Azure Functions' and armRegionName eq 'eastus' and priceType eq 'Consumption'

# D4s v5 VMs in West Europe (consumption only)
armSkuName eq 'Standard_D4s_v5' and armRegionName eq 'westeurope' and priceType eq 'Consumption'

# All storage prices in a region
serviceFamily eq 'Storage' and armRegionName eq 'eastus'

# Spot pricing for a specific SKU
armSkuName eq 'Standard_D4s_v5' and contains(meterName, 'Spot') and armRegionName eq 'eastus'

# 1-year reservation pricing
serviceName eq 'Virtual Machines' and priceType eq 'Reservation' and armRegionName eq 'eastus'
```

## Full Example Fetch URL

```
https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName eq 'Azure Functions' and armRegionName eq 'eastus' and priceType eq 'Consumption'
```

URL-encode spaces as `%20` and quotes as `%27` when constructing the URL.

## Key Response Fields

```json
{
  "Items": [
    {
      "retailPrice": 0.000016,
      "unitPrice": 0.000016,
      "currencyCode": "USD",
      "unitOfMeasure": "1 Execution",
      "serviceName": "Azure Functions",
      "skuName": "Consumption Tier",
      "armRegionName": "eastus",
      "meterName": "Standard Executions",
      "productName": "Azure Functions",
      "priceType": "Consumption",
      "isPrimaryMeterRegion": true
    }
  ],
  "NextPageLink": null,
  "Count": 1
}
```

Only use items where `isPrimaryMeterRegion` is `true` unless the user specifically asks for non-primary meters.

## Supported serviceFamily Values

`Analytics`, `Compute`, `Containers`, `Data`, `Databases`, `Developer Tools`, `Integration`, `Internet of Things`, `Management and Governance`, `Networking`, `Security`, `Storage`, `Web`, `AI + Machine Learning`

## Tips

- `serviceName` values are case-sensitive. When unsure, filter by `serviceFamily` first to discover valid `serviceName` values in the results.
- If results are empty, try broadening the filter (e.g., remove `priceType` or region constraints first).
- Prices are always in USD unless `currencyCode` is specified in the request.
- For savings plan prices, look for the `savingsPlan` array on each item (only in `2023-01-01-preview`).
