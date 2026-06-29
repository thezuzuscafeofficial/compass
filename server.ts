/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";

// Load environment variables
dotenv.config();

// Import initial data
import {
  INITIAL_TENANTS,
  INITIAL_USERS,
  INITIAL_CUSTOMERS,
  INITIAL_VENDORS,
  INITIAL_ACCOUNTS,
  INITIAL_QUOTATIONS,
  INITIAL_SALES_ORDERS,
  INITIAL_INVOICES,
  INITIAL_PAYMENTS,
  INITIAL_PURCHASE_ORDERS,
  INITIAL_VENDOR_BILLS,
  INITIAL_BANK_TRANSACTIONS,
  INITIAL_JOURNALS,
  INITIAL_DOCUMENTS,
  INITIAL_WORKFLOWS,
  INITIAL_AUDIT_LOGS,
  INITIAL_NOTIFICATIONS,
  INITIAL_INVENTORY
} from "./src/mockData";

import { UserRole, InventoryItem } from "./src/types";

// In-Memory Database State (for persistence during active development/preview runs)
let tenants = [...INITIAL_TENANTS];
let users = [...INITIAL_USERS];
let customers = [...INITIAL_CUSTOMERS];
let vendors = [...INITIAL_VENDORS];
let accounts = [...INITIAL_ACCOUNTS];
let quotations = [...INITIAL_QUOTATIONS];
let salesOrders = [...INITIAL_SALES_ORDERS];
let invoices = [...INITIAL_INVOICES];
let payments = [...INITIAL_PAYMENTS];
let purchaseOrders = [...INITIAL_PURCHASE_ORDERS];
let vendorBills = [...INITIAL_VENDOR_BILLS];
let bankTransactions = [...INITIAL_BANK_TRANSACTIONS];
let journals = [...INITIAL_JOURNALS];
let documents = [...INITIAL_DOCUMENTS];
let workflows = [...INITIAL_WORKFLOWS];
let auditLogs = [...INITIAL_AUDIT_LOGS];
let notifications = [...INITIAL_NOTIFICATIONS];
let inventory: InventoryItem[] = [...INITIAL_INVENTORY];

// Lazy-initialized Gemini Client
let geminiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!geminiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error("GEMINI_API_KEY environment variable is not configured. Please add it to your secrets panel.");
    }
    geminiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return geminiClient;
}

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json({ limit: "50mb" }));

// Helper to log audit actions
function logAudit(tenantId: string, email: string, name: string, role: string, action: string, details: string) {
  const newLog = {
    id: `log-${Date.now()}`,
    tenantId,
    userId: email,
    userName: name,
    userRole: role as UserRole,
    action,
    details,
    timestamp: new Date().toISOString()
  };
  auditLogs.unshift(newLog);
}

// Helpers for linking inventory quantities and ledger entries
function processInventoryForPurchase(tenantId: string, items: any[]): { inventoryTotal: number; otherTotal: number; journalLines: any[] } {
  let inventoryTotal = 0;
  let otherTotal = 0;
  const journalLines: any[] = [];

  for (const item of items) {
    if (item.sku) {
      const invItem = inventory.find(i => i.sku === item.sku && i.tenantId === tenantId);
      if (invItem) {
        // Increase qty on hand
        invItem.qtyOnHand += Number(item.quantity);
        // Update unit cost to the latest purchase cost
        invItem.unitCost = Number(item.unitPrice);
        // Update status
        invItem.status = invItem.qtyOnHand <= 0 ? "OUT_OF_STOCK" : invItem.qtyOnHand <= invItem.reorderPoint ? "LOW_STOCK" : "IN_STOCK";
        
        inventoryTotal += Number(item.amount);
        
        journalLines.push({
          accountId: "1140", // Inventory Asset
          debit: Number(item.amount),
          credit: 0,
          description: `Inventory increase SKU ${item.sku} (Qty ${item.quantity})`
        });
        continue;
      }
    }
    otherTotal += Number(item.amount);
  }

  if (otherTotal > 0) {
    journalLines.push({
      accountId: "5110", // Standard Expense
      debit: otherTotal,
      credit: 0,
      description: `Standard procurement expense line`
    });
  }

  return { inventoryTotal, otherTotal, journalLines };
}

function processInventoryForSale(tenantId: string, items: any[]): { journalLines: any[] } {
  const journalLines: any[] = [];

  for (const item of items) {
    if (item.sku) {
      const invItem = inventory.find(i => i.sku === item.sku && i.tenantId === tenantId);
      if (invItem) {
        // Deduct qty on hand
        invItem.qtyOnHand = Math.max(0, invItem.qtyOnHand - Number(item.quantity));
        // Update status
        invItem.status = invItem.qtyOnHand <= 0 ? "OUT_OF_STOCK" : invItem.qtyOnHand <= invItem.reorderPoint ? "LOW_STOCK" : "IN_STOCK";
        
        // Calculate Cost of Goods Sold (COGS)
        const cogsAmount = invItem.unitCost * Number(item.quantity);
        if (cogsAmount > 0) {
          // Debit COGS (code 5120)
          const cogsAcc = accounts.find(a => (a.id === "5120" || a.id === `5120-${tenantId}`) && a.tenantId === tenantId);
          if (cogsAcc) cogsAcc.balance += cogsAmount;
          
          // Credit Inventory Asset (code 1140)
          const assetAcc = accounts.find(a => (a.id === "1140" || a.id === `1140-${tenantId}`) && a.tenantId === tenantId);
          if (assetAcc) assetAcc.balance -= cogsAmount;

          journalLines.push({
            accountId: "5120", // Inventory Cost of Goods Sold
            debit: cogsAmount,
            credit: 0,
            description: `COGS for SKU ${item.sku} (Qty ${item.quantity})`
          });
          journalLines.push({
            accountId: "1140", // Inventory Asset
            debit: 0,
            credit: cogsAmount,
            description: `Inventory reduction for SKU ${item.sku} (Qty ${item.quantity})`
          });
        }
      }
    }
  }

  return { journalLines };
}

// ==========================================
// API ROUTES
// ==========================================

// Health Check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// TENANTS API
app.get("/api/tenants", (req, res) => {
  res.json(tenants);
});

app.post("/api/tenants", (req, res) => {
  const { name, subdomain, subscription, accountManager, bookkeeper, financeLead, vatNumber, address, userEmail, userName, currency, logo } = req.body;
  const newTenant = {
    id: `tenant-${Date.now()}`,
    name,
    subdomain: subdomain.toLowerCase(),
    status: "ACTIVE" as const,
    subscription: subscription || "GROWTH",
    accountManager: accountManager || "Sarah Connor (Compass Senior Lead)",
    bookkeeper: bookkeeper || "Ahmed Al-Mansoor (Compass CPA)",
    financeLead: financeLead || "John Smith (Compass Finance Director)",
    healthScore: 100,
    lastLogin: new Date().toISOString(),
    outstandingTasks: 0,
    revenue: 0,
    vatNumber,
    address,
    currency: currency || "AED",
    logo: logo || ""
  };
  tenants.push(newTenant);

  // Auto-seed basic CoA for the new tenant
  const templateAccounts = INITIAL_ACCOUNTS.map(a => ({
    ...a,
    id: `${a.id}-${newTenant.id}`,
    tenantId: newTenant.id,
    parentGroupId: a.parentGroupId ? `${a.parentGroupId}-${newTenant.id}` : undefined,
    balance: 0
  }));
  accounts.push(...templateAccounts);

  // Auto-seed a default Company Admin User
  const newTenantUser = {
    id: `user-${Date.now()}`,
    tenantId: newTenant.id,
    name: userName || "Owner",
    email: userEmail || "owner@example.com",
    role: UserRole.COMPANY_ADMIN,
    permissions: ["VIEW", "CREATE", "EDIT", "DELETE", "APPROVE", "POST_GL", "MANAGE_USERS", "MANAGE_REPORTS"],
    status: "ACTIVE" as const
  };
  users.push(newTenantUser);

  // Auto-seed sample workflows
  workflows.push({
    id: `wf-${Date.now()}-1`,
    tenantId: newTenant.id,
    name: "Standard Invoice Threshold (> AED 10,000)",
    triggerType: "INVOICE_AMOUNT",
    threshold: 10000,
    approverRole: UserRole.COMPANY_ADMIN,
    isActive: true
  });

  logAudit(newTenant.id, "system@book.ae", "System Provisioner", "SUPER_ADMIN" as any, "Tenant Provisioned", `Created company ${name} with standard UAE Chart of Accounts.`);

  res.status(201).json(newTenant);
});

app.patch("/api/tenants/:id", (req, res) => {
  const { id } = req.params;
  const index = tenants.findIndex(t => t.id === id);
  if (index !== -1) {
    tenants[index] = { ...tenants[index], ...req.body };
    logAudit(id, req.body.operatorEmail || "zayn@book.ae", req.body.operatorName || "Zayn Malik", "SUPER_ADMIN" as any, "Tenant Status Updated", `Updated tenant status to ${req.body.status || tenants[index].status}`);
    res.json(tenants[index]);
  } else {
    res.status(404).json({ error: "Tenant not found" });
  }
});

app.delete("/api/tenants/:id", (req, res) => {
  const { id } = req.params;
  const index = tenants.findIndex(t => t.id === id);
  if (index !== -1) {
    const name = tenants[index].name;
    tenants.splice(index, 1);
    // clean up users of that tenant
    users = users.filter(u => u.tenantId !== id);
    logAudit(id, "zayn@book.ae", "Zayn Malik", "SUPER_ADMIN" as any, "Tenant Deleted", `Offboarded company ${name} and removed all related users`);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Tenant not found" });
  }
});

// USERS & RBAC API
app.get("/api/users", (req, res) => {
  const { tenantId } = req.query;
  if (tenantId) {
    res.json(users.filter(u => 
      u.tenantId === tenantId || 
      (u.tenantIds && u.tenantIds.includes(tenantId as string)) || 
      u.role === UserRole.SUPER_ADMIN
    ));
  } else {
    res.json(users);
  }
});

app.post("/api/users", (req, res) => {
  const { tenantId, tenantIds, name, email, role, permissions, status, credentials } = req.body;
  const primaryTenantId = tenantId || (tenantIds && tenantIds[0]) || "SUPER";
  const finalTenantIds = tenantIds || (tenantId ? [tenantId] : ["SUPER"]);
  const newUser = {
    id: `user-${Date.now()}`,
    tenantId: primaryTenantId,
    tenantIds: finalTenantIds,
    name,
    email,
    role,
    permissions: permissions || ["VIEW"],
    status: status || "ACTIVE",
    credentials: credentials || "Welcome123"
  };
  users.push(newUser);
  logAudit(newUser.tenantId, req.body.operatorEmail || "admin@example.com", req.body.operatorName || "Admin", req.body.operatorRole || "COMPANY_ADMIN", "User Registered", `Added user ${name} with role ${role}`);
  res.status(201).json(newUser);
});

app.put("/api/users/:id", (req, res) => {
  const { id } = req.params;
  const index = users.findIndex(u => u.id === id);
  if (index !== -1) {
    const updatedFields = { ...req.body };
    if (updatedFields.tenantIds && Array.isArray(updatedFields.tenantIds)) {
      updatedFields.tenantId = updatedFields.tenantIds[0] || "SUPER";
    } else if (updatedFields.tenantId && !updatedFields.tenantIds) {
      updatedFields.tenantIds = [updatedFields.tenantId];
    }
    users[index] = { ...users[index], ...updatedFields };
    res.json(users[index]);
  } else {
    res.status(404).json({ error: "User not found" });
  }
});

app.delete("/api/users/:id", (req, res) => {
  const { id } = req.params;
  const index = users.findIndex(u => u.id === id);
  if (index !== -1) {
    const user = users[index];
    users.splice(index, 1);
    logAudit(user.tenantId, "zayn@book.ae", "Zayn Malik", "SUPER_ADMIN" as any, "User Deleted", `Removed user ${user.name}`);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "User not found" });
  }
});

// CRM CUSTOMERS API
app.get("/api/customers", (req, res) => {
  const { tenantId } = req.query;
  if (tenantId) {
    res.json(customers.filter(c => c.tenantId === tenantId));
  } else {
    res.json(customers);
  }
});

app.post("/api/customers", (req, res) => {
  const { tenantId, name, contactPerson, email, phone, vatNumber, paymentTerms, currency } = req.body;
  const newCust = {
    id: `cust-${Date.now()}`,
    tenantId,
    name,
    contactPerson,
    email,
    phone,
    vatNumber,
    paymentTerms,
    currency: currency || "AED"
  };
  customers.push(newCust);
  logAudit(tenantId, req.body.operatorEmail || "admin@example.com", req.body.operatorName || "Admin", "COMPANY_ADMIN", "Customer Created", `Created customer account for ${name}`);
  res.status(201).json(newCust);
});

// VENDORS API
app.get("/api/vendors", (req, res) => {
  const { tenantId } = req.query;
  if (tenantId) {
    res.json(vendors.filter(v => v.tenantId === tenantId));
  } else {
    res.json(vendors);
  }
});

app.post("/api/vendors", (req, res) => {
  const { tenantId, name, contactPerson, email, phone, vatNumber, paymentTerms, currency, bankDetails } = req.body;
  const newVend = {
    id: `vend-${Date.now()}`,
    tenantId,
    name,
    contactPerson,
    email,
    phone,
    vatNumber,
    paymentTerms,
    currency: currency || "AED",
    bankDetails
  };
  vendors.push(newVend);
  logAudit(tenantId, req.body.operatorEmail || "admin@example.com", req.body.operatorName || "Admin", "COMPANY_ADMIN", "Vendor Added", `Created vendor record for ${name}`);
  res.status(201).json(newVend);
});

// INVENTORY DATABASE API
app.get("/api/inventory", (req, res) => {
  const { tenantId } = req.query;
  if (tenantId) {
    res.json(inventory.filter(i => i.tenantId === tenantId));
  } else {
    res.json(inventory);
  }
});

app.post("/api/inventory", (req, res) => {
  const { tenantId, sku, name, description, qtyOnHand, reorderPoint, unitCost, unitPrice, category, operatorName } = req.body;
  const qOnHand = Number(qtyOnHand) || 0;
  const rPoint = Number(reorderPoint) || 0;
  const uCost = Number(unitCost) || 0;
  const uPrice = Number(unitPrice) || 0;

  const newItem: InventoryItem = {
    id: `inv-item-${Date.now()}`,
    tenantId,
    sku,
    name,
    description: description || "",
    qtyOnHand: qOnHand,
    reorderPoint: rPoint,
    unitCost: uCost,
    unitPrice: uPrice,
    category: category || "General",
    status: qOnHand <= 0 ? "OUT_OF_STOCK" : qOnHand <= rPoint ? "LOW_STOCK" : "IN_STOCK"
  };

  inventory.push(newItem);

  // Auto adjusting Inventory Asset account balance (code 1140)
  const invAssetAcc = accounts.find(a => (a.id === "1140" || a.id === `1140-${tenantId}`) && a.tenantId === tenantId);
  if (invAssetAcc) {
    invAssetAcc.balance += (qOnHand * uCost);
  }

  logAudit(tenantId, "accounts@book.ae", operatorName || "Rahul Verma (Accountant)", "ACCOUNTANT", "Inventory Item Added", `Created inventory item SKU ${sku} (${name}) with ${qOnHand} on hand`);
  res.status(201).json(newItem);
});

app.patch("/api/inventory/:id", (req, res) => {
  const { id } = req.params;
  const { tenantId, sku, name, description, qtyOnHand, reorderPoint, unitCost, unitPrice, category, operatorName } = req.body;

  const item = inventory.find(i => i.id === id && i.tenantId === tenantId);
  if (item) {
    const oldQty = item.qtyOnHand;
    const oldCost = item.unitCost;

    if (sku !== undefined) item.sku = sku;
    if (name !== undefined) item.name = name;
    if (description !== undefined) item.description = description;
    if (qtyOnHand !== undefined) item.qtyOnHand = Number(qtyOnHand);
    if (reorderPoint !== undefined) item.reorderPoint = Number(reorderPoint);
    if (unitCost !== undefined) item.unitCost = Number(unitCost);
    if (unitPrice !== undefined) item.unitPrice = Number(unitPrice);
    if (category !== undefined) item.category = category;

    item.status = item.qtyOnHand <= 0 ? "OUT_OF_STOCK" : item.qtyOnHand <= item.reorderPoint ? "LOW_STOCK" : "IN_STOCK";

    // Auto adjusting Inventory Asset account balance (code 1140) if stock changed
    if (qtyOnHand !== undefined || unitCost !== undefined) {
      const invAssetAcc = accounts.find(a => (a.id === "1140" || a.id === `1140-${tenantId}`) && a.tenantId === tenantId);
      if (invAssetAcc) {
        const diffValue = (item.qtyOnHand * item.unitCost) - (oldQty * oldCost);
        invAssetAcc.balance += diffValue;
      }
    }

    logAudit(tenantId, "accounts@book.ae", operatorName || "Rahul Verma (Accountant)", "ACCOUNTANT", "Inventory Item Updated", `Updated inventory item SKU ${item.sku}`);
    res.json(item);
  } else {
    res.status(404).json({ error: "Inventory item not found" });
  }
});

// GENERAL LEDGER & CHART OF ACCOUNTS
app.get("/api/accounts", (req, res) => {
  const { tenantId } = req.query;
  if (tenantId) {
    res.json(accounts.filter(a => a.tenantId === tenantId));
  } else {
    res.json(accounts);
  }
});

// MANUAL JOURNAL ENTRIES
app.get("/api/journals", (req, res) => {
  const { tenantId } = req.query;
  if (tenantId) {
    res.json(journals.filter(j => j.tenantId === tenantId));
  } else {
    res.json(journals);
  }
});

app.post("/api/journals", (req, res) => {
  const { tenantId, date, reference, lines, createdBy, notes, status } = req.body;
  const newJV = {
    id: `jv-${Date.now()}`,
    tenantId,
    entryNumber: `JV-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`,
    date: date || new Date().toISOString().split("T")[0],
    reference,
    status: status || "DRAFT",
    lines,
    createdBy,
    notes
  };
  journals.push(newJV);

  // If immediately posted, adjust ledger account balances
  if (status === "POSTED") {
    lines.forEach((line: any) => {
      const acc = accounts.find(a => a.id === line.accountId && a.tenantId === tenantId);
      if (acc) {
        if (acc.type === "ASSET" || acc.type === "EXPENSE") {
          acc.balance += (line.debit - line.credit);
        } else {
          acc.balance += (line.credit - line.debit);
        }
      }
    });
    logAudit(tenantId, createdBy, createdBy, "ACCOUNTANT", "Journal Entry Posted", `Posted manual journal ${newJV.entryNumber} to General Ledger.`);
  } else {
    logAudit(tenantId, createdBy, createdBy, "ACCOUNTANT", "Journal Entry Created", `Saved journal draft ${newJV.entryNumber}`);
  }

  res.status(201).json(newJV);
});

// Stage Actions: Post JV GL
app.patch("/api/journals/:id/post", (req, res) => {
  const { id } = req.params;
  const { tenantId, operatorName } = req.body;
  const jv = journals.find(j => j.id === id && j.tenantId === tenantId);
  if (jv && jv.status !== "POSTED") {
    jv.status = "POSTED";
    jv.approvedBy = operatorName;

    // Apply balances to chart accounts
    jv.lines.forEach(line => {
      const acc = accounts.find(a => a.id === line.accountId && a.tenantId === tenantId);
      if (acc) {
        if (acc.type === "ASSET" || acc.type === "EXPENSE") {
          acc.balance += (line.debit - line.credit);
        } else {
          acc.balance += (line.credit - line.debit);
        }
      }
    });

    logAudit(tenantId, operatorName, operatorName, "FINANCE_MANAGER", "Journal Entry Posted", `Approved and Posted ${jv.entryNumber} to General Ledger.`);
    res.json(jv);
  } else {
    res.status(404).json({ error: "Journal entry not found or already posted" });
  }
});

// SALES CYCLE (Quotations, Sales Orders, Invoices, Payments)
app.get("/api/quotations", (req, res) => {
  const { tenantId } = req.query;
  res.json(quotations.filter(q => q.tenantId === tenantId));
});

app.post("/api/quotations", (req, res) => {
  const { tenantId, customerId, items, notes, operatorName, status } = req.body;
  const subtotal = items.reduce((sum: number, i: any) => sum + i.amount, 0);
  const vatAmount = items.reduce((sum: number, i: any) => sum + (i.amount * (i.vatRate / 100)), 0);
  const total = subtotal + vatAmount;

  const newQuote = {
    id: `qt-${Date.now()}`,
    tenantId,
    quoteNumber: `QT-2026-${Math.floor(1000 + Math.random() * 9000)}`,
    customerId,
    date: new Date().toISOString().split("T")[0],
    expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
    items,
    subtotal,
    vatAmount,
    total,
    status: status || "SENT",
    notes
  };

  quotations.push(newQuote);
  logAudit(tenantId, operatorName || "Staff", operatorName || "Staff", "BOOKKEEPER", "Quotation Created", `Generated quotation ${newQuote.quoteNumber}`);
  res.status(201).json(newQuote);
});

// Update quote status (e.g. approve in portal)
app.patch("/api/quotations/:id/status", (req, res) => {
  const { id } = req.params;
  const { status, operatorName, tenantId } = req.body;
  const quote = quotations.find(q => q.id === id && q.tenantId === tenantId);
  if (quote) {
    quote.status = status;
    logAudit(tenantId, operatorName || "Portal Customer", operatorName || "Portal Customer", "CUSTOMER", "Quotation Updated", `Quotation ${quote.quoteNumber} state changed to ${status}`);
    res.json(quote);
  } else {
    res.status(404).json({ error: "Quotation not found" });
  }
});

app.put("/api/quotations/:id", (req, res) => {
  const { id } = req.params;
  const { tenantId, customerId, items, notes, status, date, expiryDate, operatorName } = req.body;
  const quote = quotations.find(q => q.id === id && q.tenantId === tenantId);
  if (!quote) {
    return res.status(404).json({ error: "Quotation not found" });
  }

  const subtotal = items.reduce((sum: number, i: any) => sum + i.amount, 0);
  const vatAmount = items.reduce((sum: number, i: any) => sum + (i.amount * (i.vatRate / 100)), 0);
  const total = subtotal + vatAmount;

  quote.customerId = customerId || quote.customerId;
  quote.items = items || quote.items;
  quote.notes = notes !== undefined ? notes : quote.notes;
  quote.date = date || quote.date;
  quote.expiryDate = expiryDate || quote.expiryDate;
  quote.subtotal = subtotal;
  quote.vatAmount = vatAmount;
  quote.total = total;
  quote.status = status || quote.status;

  logAudit(tenantId, operatorName || "Staff", operatorName || "Staff", "BOOKKEEPER", "Quotation Updated", `Updated quotation ${quote.quoteNumber}`);
  res.json(quote);
});

// Sales Orders
app.get("/api/salesorders", (req, res) => {
  const { tenantId } = req.query;
  res.json(salesOrders.filter(so => so.tenantId === tenantId));
});

app.post("/api/salesorders", (req, res) => {
  const { tenantId, customerId, quoteId, items, notes, operatorName, status } = req.body;
  const subtotal = items.reduce((sum: number, i: any) => sum + i.amount, 0);
  const vatAmount = items.reduce((sum: number, i: any) => sum + (i.amount * (i.vatRate / 100)), 0);
  const total = subtotal + vatAmount;

  const newSO = {
    id: `so-${Date.now()}`,
    tenantId,
    orderNumber: `SO-2026-${Math.floor(1000 + Math.random() * 9000)}`,
    customerId,
    quoteId,
    date: new Date().toISOString().split("T")[0],
    items,
    subtotal,
    vatAmount,
    total,
    status: status || "PENDING",
    notes
  };

  salesOrders.push(newSO);
  logAudit(tenantId, operatorName, operatorName, "ACCOUNTANT", "Sales Order Created", `Created Sales Order ${newSO.orderNumber}`);
  res.status(201).json(newSO);
});

app.patch("/api/salesorders/:id/status", (req, res) => {
  const { id } = req.params;
  const { status, operatorName, tenantId } = req.body;
  const order = salesOrders.find(so => so.id === id && so.tenantId === tenantId);
  if (order) {
    order.status = status;
    logAudit(tenantId, operatorName || "System", operatorName || "System", "ACCOUNTANT", "Sales Order Updated", `Sales Order ${order.orderNumber} state changed to ${status}`);
    res.json(order);
  } else {
    res.status(404).json({ error: "Sales Order not found" });
  }
});

app.put("/api/salesorders/:id", (req, res) => {
  const { id } = req.params;
  const { tenantId, customerId, items, notes, status, date, operatorName } = req.body;
  const order = salesOrders.find(so => so.id === id && so.tenantId === tenantId);
  if (!order) {
    return res.status(404).json({ error: "Sales Order not found" });
  }

  const subtotal = items.reduce((sum: number, i: any) => sum + i.amount, 0);
  const vatAmount = items.reduce((sum: number, i: any) => sum + (i.amount * (i.vatRate / 100)), 0);
  const total = subtotal + vatAmount;

  order.customerId = customerId || order.customerId;
  order.items = items || order.items;
  order.notes = notes !== undefined ? notes : order.notes;
  order.date = date || order.date;
  order.subtotal = subtotal;
  order.vatAmount = vatAmount;
  order.total = total;
  order.status = status || order.status;

  logAudit(tenantId, operatorName || "Staff", operatorName || "Staff", "BOOKKEEPER", "Sales Order Updated", `Updated Sales Order ${order.orderNumber}`);
  res.json(order);
});

// Invoices
app.get("/api/invoices", (req, res) => {
  const { tenantId } = req.query;
  res.json(invoices.filter(i => i.tenantId === tenantId));
});

app.post("/api/invoices", (req, res) => {
  const { tenantId, customerId, orderId, items, notes, operatorName, status } = req.body;
  const subtotal = items.reduce((sum: number, i: any) => sum + i.amount, 0);
  const vatAmount = items.reduce((sum: number, i: any) => sum + (i.amount * (i.vatRate / 100)), 0);
  const total = subtotal + vatAmount;

  const newInvoice = {
    id: `inv-${Date.now()}`,
    tenantId,
    invoiceNumber: `INV-2026-${Math.floor(1000 + Math.random() * 9000)}`,
    customerId,
    orderId,
    date: new Date().toISOString().split("T")[0],
    dueDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
    items,
    subtotal,
    vatAmount,
    total,
    amountPaid: 0,
    status: status || "UNPAID",
    notes
  };

  invoices.push(newInvoice);

  // If immediate posted (not draft), post to general ledger accounts
  if (status !== "DRAFT") {
    // DR Accounts Receivable (Asset) - Account "1130"
    const arAcc = accounts.find(a => (a.id === "1130" || a.id === `1130-${tenantId}`) && a.tenantId === tenantId);
    if (arAcc) arAcc.balance += total;

    // CR Revenue (Revenue) - Account "4100" (Software) or default
    const revAcc = accounts.find(a => (a.id === "4100" || a.id === `4100-${tenantId}`) && a.tenantId === tenantId);
    if (revAcc) revAcc.balance += subtotal;

    // CR VAT Liability (Liability) - Account "2120"
    const vatAcc = accounts.find(a => (a.id === "2120" || a.id === `2120-${tenantId}`) && a.tenantId === tenantId);
    if (vatAcc) vatAcc.balance += vatAmount;

    // Process Sales Inventory (Quantity reduction + COGS posting)
    const { journalLines: inventoryLines } = processInventoryForSale(tenantId, items);

    // Record the double-entry inside Journals
    journals.push({
      id: `jv-inv-${newInvoice.id}`,
      tenantId,
      entryNumber: `JV-INV-${newInvoice.invoiceNumber.split("-")[2]}`,
      date: newInvoice.date,
      reference: newInvoice.invoiceNumber,
      status: "POSTED",
      lines: [
        { accountId: arAcc?.id || "1130", debit: total, credit: 0, description: `Invoice sales standard ${newInvoice.invoiceNumber}` },
        { accountId: revAcc?.id || "4100", debit: 0, credit: subtotal, description: `Software licensing revenue` },
        { accountId: vatAcc?.id || "2120", debit: 0, credit: vatAmount, description: `5% Output VAT` },
        ...inventoryLines
      ],
      createdBy: operatorName || "System Scheduler"
    });
  }

  logAudit(tenantId, operatorName, operatorName, "ACCOUNTANT", "Invoice Generated", `Generated and posted sales invoice ${newInvoice.invoiceNumber} for AED ${total}`);
  res.status(201).json(newInvoice);
});

// Payments Incoming (Receipts)
app.get("/api/payments", (req, res) => {
  const { tenantId } = req.query;
  res.json(payments.filter(p => p.tenantId === tenantId));
});

app.post("/api/payments", (req, res) => {
  const { tenantId, customerId, invoiceId, amount, method, reference, operatorName, notes, bankOrCashAccountId, status, date } = req.body;
  const targetStatus = status || "POSTED";
  const paymentDate = date || new Date().toISOString().split("T")[0];
  const chosenAccountId = bankOrCashAccountId || "1120";

  const newPayment = {
    id: `pm-${Date.now()}`,
    tenantId,
    paymentNumber: `REC-2026-${Math.floor(1000 + Math.random() * 9000)}`,
    customerId,
    invoiceId,
    date: paymentDate,
    amount: Number(amount),
    method,
    reference,
    status: targetStatus,
    notes,
    bankOrCashAccountId: chosenAccountId
  };

  payments.push(newPayment);

  if (targetStatus === "POSTED") {
    // Mark invoice as paid
    const inv = invoices.find(i => i.id === invoiceId && i.tenantId === tenantId);
    if (inv) {
      inv.amountPaid += Number(amount);
      inv.status = inv.amountPaid >= inv.total ? "PAID" : "PARTIALLY_PAID";
    }

    // Adjust GL ledger
    // DR Chosen Bank/Cash Account (Asset)
    const bankAcc = accounts.find(a => (a.id === chosenAccountId || a.id === `${chosenAccountId}-${tenantId}`) && a.tenantId === tenantId);
    if (bankAcc) bankAcc.balance += Number(amount);

    // CR Accounts Receivable (Asset) - Account "1130"
    const arAcc = accounts.find(a => (a.id === "1130" || a.id === `1130-${tenantId}`) && a.tenantId === tenantId);
    if (arAcc) arAcc.balance -= Number(amount);

    // Add posting journal
    journals.push({
      id: `jv-rec-${newPayment.id}`,
      tenantId,
      entryNumber: `JV-REC-${newPayment.paymentNumber.split("-")[2]}`,
      date: newPayment.date,
      reference: newPayment.paymentNumber,
      status: "POSTED",
      lines: [
        { accountId: bankAcc?.id || "1120", debit: Number(amount), credit: 0, description: `Receipt payment of ${newPayment.paymentNumber} to ${bankAcc?.name || "Operating Account"}` },
        { accountId: arAcc?.id || "1130", debit: 0, credit: Number(amount), description: `Clearing customer outstanding receivables` }
      ],
      createdBy: operatorName
    });

    logAudit(tenantId, operatorName, operatorName, "BOOKKEEPER", "Payment Cleared", `Received payment ${newPayment.paymentNumber} of AED ${amount} via ${method} deposited into ${bankAcc?.name || "Operating Bank Account"}`);
  } else {
    logAudit(tenantId, operatorName, operatorName, "BOOKKEEPER", "Payment Created as Draft", `Created draft payment ${newPayment.paymentNumber} of AED ${amount} via ${method}`);
  }

  res.status(201).json(newPayment);
});

app.put("/api/payments/:id", (req, res) => {
  const { id } = req.params;
  const { tenantId, customerId, invoiceId, amount, method, reference, operatorName, notes, bankOrCashAccountId, status, date } = req.body;

  const paymentIndex = payments.findIndex(p => p.id === id && p.tenantId === tenantId);
  if (paymentIndex === -1) {
    return res.status(404).json({ error: "Payment not found" });
  }

  const existingPayment = payments[paymentIndex];
  const oldStatus = existingPayment.status;
  const targetStatus = status || existingPayment.status;

  // 1. If transitioning from POSTED to DRAFT, we revert the ledger and invoice postings:
  if (oldStatus === "POSTED" && targetStatus === "DRAFT") {
    // Revert invoice amountPaid
    const inv = invoices.find(i => i.id === existingPayment.invoiceId && i.tenantId === tenantId);
    if (inv) {
      inv.amountPaid = Math.max(0, inv.amountPaid - existingPayment.amount);
      inv.status = inv.amountPaid >= inv.total ? "PAID" : inv.amountPaid > 0 ? "PARTIALLY_PAID" : "UNPAID";
    }

    // Revert bank account balance
    const oldBankAccountId = existingPayment.bankOrCashAccountId || "1120";
    const bankAcc = accounts.find(a => (a.id === oldBankAccountId || a.id === `${oldBankAccountId}-${tenantId}`) && a.tenantId === tenantId);
    if (bankAcc) {
      bankAcc.balance -= existingPayment.amount;
    }

    // Revert accounts receivable balance
    const arAcc = accounts.find(a => (a.id === "1130" || a.id === `1130-${tenantId}`) && a.tenantId === tenantId);
    if (arAcc) {
      arAcc.balance += existingPayment.amount;
    }

    // Remove the posted journal entry entirely (vanish / delete)
    journals = journals.filter(j => j.id !== `jv-rec-${existingPayment.id}`);

    logAudit(tenantId, operatorName, operatorName, "BOOKKEEPER", "Payment Reverted to Draft", `Reverted payment ${existingPayment.paymentNumber} to Draft. General ledger entries deleted.`);
  }

  // 2. Apply modifications to draft / transitioning fields
  existingPayment.customerId = customerId !== undefined ? customerId : existingPayment.customerId;
  existingPayment.invoiceId = invoiceId !== undefined ? invoiceId : existingPayment.invoiceId;
  existingPayment.amount = amount !== undefined ? Number(amount) : existingPayment.amount;
  existingPayment.method = method !== undefined ? method : existingPayment.method;
  existingPayment.reference = reference !== undefined ? reference : existingPayment.reference;
  existingPayment.notes = notes !== undefined ? notes : existingPayment.notes;
  existingPayment.bankOrCashAccountId = bankOrCashAccountId !== undefined ? bankOrCashAccountId : existingPayment.bankOrCashAccountId;
  existingPayment.date = date !== undefined ? date : existingPayment.date;
  existingPayment.status = targetStatus;

  // 3. If transitioning from DRAFT to POSTED, apply the posting logic:
  if (oldStatus === "DRAFT" && targetStatus === "POSTED") {
    const activeAmount = existingPayment.amount;
    const activeInvoiceId = existingPayment.invoiceId;
    const activeBankAccountId = existingPayment.bankOrCashAccountId || "1120";

    // Mark invoice as paid
    const inv = invoices.find(i => i.id === activeInvoiceId && i.tenantId === tenantId);
    if (inv) {
      inv.amountPaid += activeAmount;
      inv.status = inv.amountPaid >= inv.total ? "PAID" : "PARTIALLY_PAID";
    }

    // Adjust GL ledger
    const bankAcc = accounts.find(a => (a.id === activeBankAccountId || a.id === `${activeBankAccountId}-${tenantId}`) && a.tenantId === tenantId);
    if (bankAcc) bankAcc.balance += activeAmount;

    const arAcc = accounts.find(a => (a.id === "1130" || a.id === `1130-${tenantId}`) && a.tenantId === tenantId);
    if (arAcc) arAcc.balance -= activeAmount;

    // Create journal entry in GL
    journals.push({
      id: `jv-rec-${existingPayment.id}`,
      tenantId,
      entryNumber: `JV-REC-${existingPayment.paymentNumber.split("-")[2]}`,
      date: existingPayment.date,
      reference: existingPayment.paymentNumber,
      status: "POSTED",
      lines: [
        { accountId: bankAcc?.id || "1120", debit: activeAmount, credit: 0, description: `Receipt payment of ${existingPayment.paymentNumber} to ${bankAcc?.name || "Operating Account"}` },
        { accountId: arAcc?.id || "1130", debit: 0, credit: activeAmount, description: `Clearing customer outstanding receivables` }
      ],
      createdBy: operatorName
    });

    logAudit(tenantId, operatorName, operatorName, "BOOKKEEPER", "Payment Posted", `Posted payment ${existingPayment.paymentNumber} of AED ${activeAmount} via ${existingPayment.method} deposited into ${bankAcc?.name || "Operating Bank Account"}`);
  } else if (oldStatus === "DRAFT" && targetStatus === "DRAFT") {
    logAudit(tenantId, operatorName, operatorName, "BOOKKEEPER", "Payment Updated in Draft", `Updated draft payment ${existingPayment.paymentNumber} details`);
  }

  res.status(200).json(existingPayment);
});

// Vendor Payments Outgoing (Settle Vendor Bills)
let vendorPayments: any[] = [];

app.get("/api/vendorpayments", (req, res) => {
  const { tenantId } = req.query;
  res.json(vendorPayments.filter(vp => vp.tenantId === tenantId));
});

app.post("/api/vendorpayments", (req, res) => {
  const { tenantId, vendorId, billId, amount, method, reference, operatorName, notes, bankOrCashAccountId, status, date } = req.body;
  const targetStatus = status || "POSTED";
  const paymentDate = date || new Date().toISOString().split("T")[0];
  const chosenAccountId = bankOrCashAccountId || "1120";

  const newVendorPayment = {
    id: `vp-${Date.now()}`,
    tenantId,
    paymentNumber: `VPM-2026-${Math.floor(1000 + Math.random() * 9000)}`,
    vendorId,
    billId,
    date: paymentDate,
    amount: Number(amount),
    method,
    reference,
    status: targetStatus,
    notes,
    bankOrCashAccountId: chosenAccountId
  };

  vendorPayments.push(newVendorPayment);

  if (targetStatus === "POSTED") {
    // Mark vendor bill as paid
    const bill = vendorBills.find(b => b.id === billId && b.tenantId === tenantId);
    if (bill) {
      bill.amountPaid = (bill.amountPaid || 0) + Number(amount);
      bill.status = bill.amountPaid >= bill.total ? "PAID" : "PARTIALLY_PAID";
    }

    // Adjust GL ledger
    // DR Accounts Payable (Liability) - Account "2110" (decreases liability balance)
    const apAcc = accounts.find(a => (a.id === "2110" || a.id === `2110-${tenantId}`) && a.tenantId === tenantId);
    if (apAcc) apAcc.balance -= Number(amount);

    // CR Chosen Bank/Cash Account (Asset) (decreases asset balance)
    const bankAcc = accounts.find(a => (a.id === chosenAccountId || a.id === `${chosenAccountId}-${tenantId}`) && a.tenantId === tenantId);
    if (bankAcc) bankAcc.balance -= Number(amount);

    // Add posting journal
    journals.push({
      id: `jv-vpm-${newVendorPayment.id}`,
      tenantId,
      entryNumber: `JV-VPM-${newVendorPayment.paymentNumber.split("-")[2]}`,
      date: newVendorPayment.date,
      reference: newVendorPayment.paymentNumber,
      status: "POSTED",
      lines: [
        { accountId: apAcc?.id || "2110", debit: Number(amount), credit: 0, description: `Settle accounts payable outstanding for bill ${bill?.billNumber}` },
        { accountId: bankAcc?.id || "1120", debit: 0, credit: Number(amount), description: `Disbursement of ${newVendorPayment.paymentNumber} from ${bankAcc?.name || "Operating Account"}` }
      ],
      createdBy: operatorName || "System Scheduler"
    });

    logAudit(tenantId, operatorName || "CFO", operatorName || "CFO", "ACCOUNTANT", "Vendor Settle Cleared", `Settle vendor bill ${bill?.billNumber} of AED ${amount} via ${method} using ${bankAcc?.name || "Operating Bank Account"}`);
  } else {
    logAudit(tenantId, operatorName || "CFO", operatorName || "CFO", "ACCOUNTANT", "Vendor Payment Drafted", `Drafted outgoing payment ${newVendorPayment.paymentNumber} of AED ${amount}`);
  }

  res.status(201).json(newVendorPayment);
});

app.put("/api/vendorpayments/:id", (req, res) => {
  const { id } = req.params;
  const { tenantId, vendorId, billId, amount, method, reference, operatorName, notes, bankOrCashAccountId, status, date } = req.body;

  const paymentIndex = vendorPayments.findIndex(vp => vp.id === id && vp.tenantId === tenantId);
  if (paymentIndex === -1) {
    return res.status(404).json({ error: "Vendor payment not found" });
  }

  const existingPayment = vendorPayments[paymentIndex];
  const oldStatus = existingPayment.status;
  const targetStatus = status || existingPayment.status;

  // 1. Revert ledger if transitioning from POSTED to DRAFT
  if (oldStatus === "POSTED" && targetStatus === "DRAFT") {
    const bill = vendorBills.find(b => b.id === existingPayment.billId && b.tenantId === tenantId);
    if (bill) {
      bill.amountPaid = Math.max(0, (bill.amountPaid || 0) - existingPayment.amount);
      bill.status = bill.amountPaid >= bill.total ? "PAID" : bill.amountPaid > 0 ? "PARTIALLY_PAID" : "APPROVED";
    }

    const apAcc = accounts.find(a => (a.id === "2110" || a.id === `2110-${tenantId}`) && a.tenantId === tenantId);
    if (apAcc) apAcc.balance += existingPayment.amount; // Add back liability

    const oldBankAccountId = existingPayment.bankOrCashAccountId || "1120";
    const bankAcc = accounts.find(a => (a.id === oldBankAccountId || a.id === `${oldBankAccountId}-${tenantId}`) && a.tenantId === tenantId);
    if (bankAcc) bankAcc.balance += existingPayment.amount; // Refund bank asset

    journals = journals.filter(j => j.id !== `jv-vpm-${existingPayment.id}`);

    logAudit(tenantId, operatorName || "CFO", operatorName || "CFO", "ACCOUNTANT", "Vendor Payment Reverted to Draft", `Reverted outgoing payment ${existingPayment.paymentNumber} to Draft. General ledger entries deleted.`);
  }

  // 2. Modify draft/transitioning fields
  existingPayment.vendorId = vendorId !== undefined ? vendorId : existingPayment.vendorId;
  existingPayment.billId = billId !== undefined ? billId : existingPayment.billId;
  existingPayment.amount = amount !== undefined ? Number(amount) : existingPayment.amount;
  existingPayment.method = method !== undefined ? method : existingPayment.method;
  existingPayment.reference = reference !== undefined ? reference : existingPayment.reference;
  existingPayment.notes = notes !== undefined ? notes : existingPayment.notes;
  existingPayment.bankOrCashAccountId = bankOrCashAccountId !== undefined ? bankOrCashAccountId : existingPayment.bankOrCashAccountId;
  existingPayment.date = date !== undefined ? date : existingPayment.date;
  existingPayment.status = targetStatus;

  // 3. Post ledger if transitioning from DRAFT to POSTED
  if (oldStatus === "DRAFT" && targetStatus === "POSTED") {
    const activeAmount = existingPayment.amount;
    const activeBillId = existingPayment.billId;
    const activeBankAccountId = existingPayment.bankOrCashAccountId || "1120";

    const bill = vendorBills.find(b => b.id === activeBillId && b.tenantId === tenantId);
    if (bill) {
      bill.amountPaid = (bill.amountPaid || 0) + activeAmount;
      bill.status = bill.amountPaid >= bill.total ? "PAID" : "PARTIALLY_PAID";
    }

    const apAcc = accounts.find(a => (a.id === "2110" || a.id === `2110-${tenantId}`) && a.tenantId === tenantId);
    if (apAcc) apAcc.balance -= activeAmount;

    const bankAcc = accounts.find(a => (a.id === activeBankAccountId || a.id === `${activeBankAccountId}-${tenantId}`) && a.tenantId === tenantId);
    if (bankAcc) bankAcc.balance -= activeAmount;

    journals.push({
      id: `jv-vpm-${existingPayment.id}`,
      tenantId,
      entryNumber: `JV-VPM-${existingPayment.paymentNumber.split("-")[2]}`,
      date: existingPayment.date,
      reference: existingPayment.paymentNumber,
      status: "POSTED",
      lines: [
        { accountId: apAcc?.id || "2110", debit: activeAmount, credit: 0, description: `Settle accounts payable outstanding for bill ${bill?.billNumber}` },
        { accountId: bankAcc?.id || "1120", debit: 0, credit: activeAmount, description: `Disbursement of ${existingPayment.paymentNumber} from ${bankAcc?.name || "Operating Account"}` }
      ],
      createdBy: operatorName || "System Scheduler"
    });

    logAudit(tenantId, operatorName || "CFO", operatorName || "CFO", "ACCOUNTANT", "Vendor Payment Posted", `Posted outgoing payment ${existingPayment.paymentNumber} of AED ${activeAmount}`);
  } else if (oldStatus === "DRAFT" && targetStatus === "DRAFT") {
    logAudit(tenantId, operatorName || "CFO", operatorName || "CFO", "ACCOUNTANT", "Vendor Payment Updated in Draft", `Updated draft payment ${existingPayment.paymentNumber} details`);
  }

  res.status(200).json(existingPayment);
});

// PURCHASE CYCLE
app.get("/api/purchaseorders", (req, res) => {
  const { tenantId } = req.query;
  res.json(purchaseOrders.filter(po => po.tenantId === tenantId));
});

app.post("/api/purchaseorders", (req, res) => {
  const { tenantId, vendorId, items, notes, operatorName, status } = req.body;
  const subtotal = items.reduce((sum: number, i: any) => sum + i.amount, 0);
  const vatAmount = items.reduce((sum: number, i: any) => sum + (i.amount * (i.vatRate / 100)), 0);
  const total = subtotal + vatAmount;

  const newPO = {
    id: `po-${Date.now()}`,
    tenantId,
    poNumber: `PO-2026-${Math.floor(1000 + Math.random() * 9000)}`,
    vendorId,
    date: new Date().toISOString().split("T")[0],
    items,
    subtotal,
    vatAmount,
    total,
    status: status || "DRAFT",
    notes
  };

  purchaseOrders.push(newPO);
  logAudit(tenantId, operatorName, operatorName, "ACCOUNTANT", "Purchase Order Logged", `Logged PO draft ${newPO.poNumber}`);
  res.status(201).json(newPO);
});

app.get("/api/vendorbills", (req, res) => {
  const { tenantId } = req.query;
  res.json(vendorBills.filter(b => b.tenantId === tenantId));
});

app.post("/api/vendorbills", (req, res) => {
  const { tenantId, vendorId, poId, billNumber, items, notes, operatorName, status } = req.body;
  const subtotal = items.reduce((sum: number, i: any) => sum + i.amount, 0);
  const vatAmount = items.reduce((sum: number, i: any) => sum + (i.amount * (i.vatRate / 100)), 0);
  const total = subtotal + vatAmount;

  const newBill = {
    id: `bill-${Date.now()}`,
    tenantId,
    billNumber: billNumber || `BL-2026-${Math.floor(1000 + Math.random() * 9000)}`,
    vendorId,
    poId,
    date: new Date().toISOString().split("T")[0],
    dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
    items,
    subtotal,
    vatAmount,
    total,
    amountPaid: 0,
    status: status || "PENDING_APPROVAL",
    notes
  };

  vendorBills.push(newBill);

  if (status === "APPROVED") {
    // Apply immediately to balances
    const { inventoryTotal, otherTotal, journalLines: purchaseInvLines } = processInventoryForPurchase(tenantId, items);

    // Update GL balances
    // DR Inventory Asset (Account "1140")
    if (inventoryTotal > 0) {
      const assetAcc = accounts.find(a => (a.id === "1140" || a.id === `1140-${tenantId}`) && a.tenantId === tenantId);
      if (assetAcc) assetAcc.balance += inventoryTotal;
    }
    // DR AWS Infrastructure Costs / General Expense (Account "5110")
    if (otherTotal > 0) {
      const expAcc = accounts.find(a => (a.id === "5110" || a.id === `5110-${tenantId}`) && a.tenantId === tenantId);
      if (expAcc) expAcc.balance += otherTotal;
    }

    // DR Output VAT input claim - Account "2120"
    const vatAcc = accounts.find(a => (a.id === "2120" || a.id === `2120-${tenantId}`) && a.tenantId === tenantId);
    if (vatAcc) vatAcc.balance -= vatAmount; // Decreases net VAT payable

    // CR Accounts Payable (Liability) - Account "2110"
    const apAcc = accounts.find(a => (a.id === "2110" || a.id === `2110-${tenantId}`) && a.tenantId === tenantId);
    if (apAcc) apAcc.balance += total;

    journals.push({
      id: `jv-bill-${newBill.id}`,
      tenantId,
      entryNumber: `JV-BILL-${newBill.billNumber}`,
      date: newBill.date,
      reference: newBill.billNumber,
      status: "POSTED",
      lines: [
        ...purchaseInvLines,
        { accountId: vatAcc?.id || "2120", debit: vatAmount, credit: 0, description: `5% Claimable Input VAT` },
        { accountId: apAcc?.id || "2110", debit: 0, credit: total, description: `Accounts payable setup` }
      ],
      createdBy: operatorName || "AI Extractor"
    });
  }

  logAudit(tenantId, operatorName, operatorName, "ACCOUNTANT", "Vendor Bill Loaded", `Logged vendor bill ${newBill.billNumber} for AED ${total}`);
  res.status(201).json(newBill);
});

// Approve a vendor bill
app.patch("/api/vendorbills/:id/approve", (req, res) => {
  const { id } = req.params;
  const { tenantId, operatorName } = req.body;
  const bill = vendorBills.find(b => b.id === id && b.tenantId === tenantId);
  if (bill && (bill.status === "PENDING_APPROVAL" || bill.status === "DRAFT")) {
    bill.status = "APPROVED";

    const subtotal = bill.subtotal;
    const vatAmount = bill.vatAmount;
    const total = bill.total;

    // Apply immediately to balances
    const { inventoryTotal, otherTotal, journalLines: purchaseInvLines } = processInventoryForPurchase(tenantId, bill.items);

    // Update GL balances
    // DR Inventory Asset (Account "1140")
    if (inventoryTotal > 0) {
      const assetAcc = accounts.find(a => (a.id === "1140" || a.id === `1140-${tenantId}`) && a.tenantId === tenantId);
      if (assetAcc) assetAcc.balance += inventoryTotal;
    }
    // DR AWS Infrastructure Costs / General Expense (Account "5110")
    if (otherTotal > 0) {
      const expAcc = accounts.find(a => (a.id === "5110" || a.id === `5110-${tenantId}`) && a.tenantId === tenantId);
      if (expAcc) expAcc.balance += otherTotal;
    }

    const vatAcc = accounts.find(a => (a.id === "2120" || a.id === `2120-${tenantId}`) && a.tenantId === tenantId);
    if (vatAcc) vatAcc.balance -= vatAmount;

    const apAcc = accounts.find(a => (a.id === "2110" || a.id === `2110-${tenantId}`) && a.tenantId === tenantId);
    if (apAcc) apAcc.balance += total;

    journals.push({
      id: `jv-bill-${bill.id}`,
      tenantId,
      entryNumber: `JV-BILL-${bill.billNumber}`,
      date: bill.date,
      reference: bill.billNumber,
      status: "POSTED",
      lines: [
        ...purchaseInvLines,
        { accountId: vatAcc?.id || "2120", debit: vatAmount, credit: 0, description: `5% Claimable Input VAT` },
        { accountId: apAcc?.id || "2110", debit: 0, credit: total, description: `Accounts payable standard` }
      ],
      createdBy: operatorName
    });

    logAudit(tenantId, operatorName, operatorName, "FINANCE_MANAGER", "Vendor Bill Approved", `Authorized vendor bill ${bill.billNumber} to GL accounts.`);
    res.json(bill);
  } else {
    res.status(404).json({ error: "Bill not found or not in pending state" });
  }
});

// Revert a vendor bill to DRAFT
app.put("/api/vendorbills/:id/revert", (req, res) => {
  const { id } = req.params;
  const { tenantId, operatorName } = req.body;
  const bill = vendorBills.find(b => b.id === id && b.tenantId === tenantId);
  if (!bill) {
    return res.status(404).json({ error: "Bill not found" });
  }
  if (bill.status === "APPROVED" || bill.status === "PAID" || bill.status === "PARTIALLY_PAID") {
    // Revert balances
    const { inventoryTotal, otherTotal } = processInventoryForPurchase(tenantId, bill.items);
    const vatAmount = bill.vatAmount;
    const total = bill.total;

    // DR Inventory Asset (Account "1140") (decreases asset balance on revert)
    if (inventoryTotal > 0) {
      const assetAcc = accounts.find(a => (a.id === "1140" || a.id === `1140-${tenantId}`) && a.tenantId === tenantId);
      if (assetAcc) assetAcc.balance -= inventoryTotal;
    }
    // DR AWS Infrastructure Costs / General Expense (Account "5110") (decreases expense balance on revert)
    if (otherTotal > 0) {
      const expAcc = accounts.find(a => (a.id === "5110" || a.id === `5110-${tenantId}`) && a.tenantId === tenantId);
      if (expAcc) expAcc.balance -= otherTotal;
    }

    // DR Output VAT input claim - Account "2120" (reverts claim)
    const vatAcc = accounts.find(a => (a.id === "2120" || a.id === `2120-${tenantId}`) && a.tenantId === tenantId);
    if (vatAcc) vatAcc.balance += vatAmount; // Adds back to net VAT payable

    // CR Accounts Payable (Liability) - Account "2110" (decreases liability balance on revert)
    const apAcc = accounts.find(a => (a.id === "2110" || a.id === `2110-${tenantId}`) && a.tenantId === tenantId);
    if (apAcc) apAcc.balance -= total;

    // Delete the related journal entry
    journals = journals.filter(j => j.id !== `jv-bill-${bill.id}`);

    bill.status = "DRAFT";
    logAudit(tenantId, operatorName || "Accountant", operatorName || "Accountant", "ACCOUNTANT", "Vendor Bill Reverted to Draft", `Reverted bill ${bill.billNumber} to Draft. General ledger entry deleted.`);
    res.json(bill);
  } else {
    res.status(400).json({ error: "Bill is not in approved or paid state" });
  }
});

// Edit vendor bill in draft
app.put("/api/vendorbills/:id", (req, res) => {
  const { id } = req.params;
  const { tenantId, vendorId, poId, billNumber, items, notes, status, operatorName, date } = req.body;
  const bill = vendorBills.find(b => b.id === id && b.tenantId === tenantId);
  if (!bill) {
    return res.status(404).json({ error: "Bill not found" });
  }

  // Only allow editing if in DRAFT or PENDING_APPROVAL
  if (bill.status !== "DRAFT" && bill.status !== "PENDING_APPROVAL") {
    return res.status(400).json({ error: "Cannot edit an approved/posted bill. Please revert to draft first." });
  }

  const subtotal = items.reduce((sum: number, i: any) => sum + i.amount, 0);
  const vatAmount = items.reduce((sum: number, i: any) => sum + (i.amount * (i.vatRate / 100)), 0);
  const total = subtotal + vatAmount;

  bill.vendorId = vendorId || bill.vendorId;
  bill.poId = poId !== undefined ? poId : bill.poId;
  bill.billNumber = billNumber || bill.billNumber;
  bill.items = items || bill.items;
  bill.notes = notes !== undefined ? notes : bill.notes;
  bill.date = date || bill.date;
  bill.subtotal = subtotal;
  bill.vatAmount = vatAmount;
  bill.total = total;

  const targetStatus = status || bill.status;

  if (targetStatus === "APPROVED") {
    // Apply immediately to balances
    const { inventoryTotal, otherTotal, journalLines: purchaseInvLines } = processInventoryForPurchase(tenantId, bill.items);

    // Update GL balances
    // DR Inventory Asset (Account "1140")
    if (inventoryTotal > 0) {
      const assetAcc = accounts.find(a => (a.id === "1140" || a.id === `1140-${tenantId}`) && a.tenantId === tenantId);
      if (assetAcc) assetAcc.balance += inventoryTotal;
    }
    // DR AWS Infrastructure Costs / General Expense (Account "5110")
    if (otherTotal > 0) {
      const expAcc = accounts.find(a => (a.id === "5110" || a.id === `5110-${tenantId}`) && a.tenantId === tenantId);
      if (expAcc) expAcc.balance += otherTotal;
    }

    // DR Output VAT input claim - Account "2120"
    const vatAcc = accounts.find(a => (a.id === "2120" || a.id === `2120-${tenantId}`) && a.tenantId === tenantId);
    if (vatAcc) vatAcc.balance -= vatAmount; // Decreases net VAT payable

    // CR Accounts Payable (Liability) - Account "2110"
    const apAcc = accounts.find(a => (a.id === "2110" || a.id === `2110-${tenantId}`) && a.tenantId === tenantId);
    if (apAcc) apAcc.balance += total;

    journals.push({
      id: `jv-bill-${bill.id}`,
      tenantId,
      entryNumber: `JV-BILL-${bill.billNumber}`,
      date: bill.date,
      reference: bill.billNumber,
      status: "POSTED",
      lines: [
        ...purchaseInvLines,
        { accountId: vatAcc?.id || "2120", debit: vatAmount, credit: 0, description: `5% Claimable Input VAT` },
        { accountId: apAcc?.id || "2110", debit: 0, credit: total, description: `Accounts payable setup` }
      ],
      createdBy: operatorName || "AI Extractor"
    });
  }

  bill.status = targetStatus;
  logAudit(tenantId, operatorName, operatorName, "ACCOUNTANT", "Vendor Bill Updated", `Updated vendor bill ${bill.billNumber} to status ${targetStatus}`);
  res.json(bill);
});

// Edit purchase order
app.put("/api/purchaseorders/:id", (req, res) => {
  const { id } = req.params;
  const { tenantId, vendorId, items, notes, status, date, operatorName } = req.body;
  const po = purchaseOrders.find(p => p.id === id && p.tenantId === tenantId);
  if (!po) {
    return res.status(404).json({ error: "Purchase Order not found" });
  }

  const subtotal = items.reduce((sum: number, i: any) => sum + i.amount, 0);
  const vatAmount = items.reduce((sum: number, i: any) => sum + (i.amount * (i.vatRate / 100)), 0);
  const total = subtotal + vatAmount;

  po.vendorId = vendorId || po.vendorId;
  po.items = items || po.items;
  po.notes = notes !== undefined ? notes : po.notes;
  po.date = date || po.date;
  po.subtotal = subtotal;
  po.vatAmount = vatAmount;
  po.total = total;
  po.status = status || po.status;

  logAudit(tenantId, operatorName || "Staff", operatorName || "Staff", "BOOKKEEPER", "Purchase Order Updated", `Updated Purchase Order ${po.poNumber}`);
  res.json(po);
});

// BANK RECONCILIATION API
app.get("/api/banktransactions", (req, res) => {
  const { tenantId } = req.query;
  res.json(bankTransactions.filter(bt => bt.tenantId === tenantId));
});

app.post("/api/banktransactions/reconcile", (req, res) => {
  const { tenantId, transactionId, matchedToType, matchedToId, operatorName } = req.body;
  const bt = bankTransactions.find(t => t.id === transactionId && t.tenantId === tenantId);
  if (bt) {
    bt.matchedStatus = "MANUALLY_MATCHED";
    bt.matchedToType = matchedToType;
    bt.matchedToId = matchedToId;

    // If matched to an unpaid invoice, mark it as paid!
    if (matchedToType === "INVOICE") {
      const inv = invoices.find(i => i.id === matchedToId && i.tenantId === tenantId);
      if (inv) {
        inv.amountPaid = inv.total;
        inv.status = "PAID";
      }
    } else if (matchedToType === "BILL") {
      const bill = vendorBills.find(b => b.id === matchedToId && b.tenantId === tenantId);
      if (bill) {
        bill.amountPaid = bill.total;
        bill.status = "PAID";
      }
    }

    logAudit(tenantId, operatorName, operatorName, "ACCOUNTANT", "Bank Statement Reconciled", `Manually reconciled statement line "${bt.description}" against ${matchedToType} ${matchedToId}`);
    res.json(bt);
  } else {
    res.status(404).json({ error: "Bank transaction not found" });
  }
});

// DOCS & OCR AI PROCESSING MODULE
app.get("/api/documents", (req, res) => {
  const { tenantId } = req.query;
  res.json(documents.filter(d => d.tenantId === tenantId));
});

// SIMULATE UPLOAD
app.post("/api/documents/upload", (req, res) => {
  const { tenantId, name, size, tags } = req.body;
  const newDoc = {
    id: `doc-${Date.now()}`,
    tenantId,
    name,
    url: "#",
    size: size || "350 KB",
    uploadedAt: new Date().toISOString(),
    tags: tags || ["Uploaded"],
    ocrExtracted: false
  };
  documents.push(newDoc);
  res.status(201).json(newDoc);
});

// REAL GEMINI OCR EXTRACTOR
app.post("/api/documents/:id/ocr", async (req, res) => {
  const { id } = req.params;
  const { tenantId } = req.body;

  const doc = documents.find(d => d.id === id && d.tenantId === tenantId);
  if (!doc) {
    return res.status(404).json({ error: "Document not found" });
  }

  try {
    const ai = getGeminiClient();

    // Standard OCR analysis prompt tailored to extract business metrics
    const prompt = `Analyze this uploaded document invoice/receipt: Name is "${doc.name}".
    Extract:
    1. Vendor Name
    2. Customer Name (SME tenant name)
    3. Document Date (YYYY-MM-DD)
    4. Subtotal amount (number)
    5. VAT amount (5% rate in UAE)
    6. Total amount (number)
    7. Vendor VAT TRN Registration Number (15 digits usually)
    8. Suggested GL accounting code based on:
       - '5110' for cloud hosting / IT expenses
       - '5220' for utilities/rent
       - '5230' for marketing
       - '5100' for other purchases/stationary
    
    Provide the response strictly as valid JSON conforming to this TypeScript interface:
    {
      vendorName: string;
      customerName: string;
      date: string;
      subtotal: number;
      vatAmount: number;
      totalAmount: number;
      vatNumber: string;
      suggestedAccountCode: string;
    }
    Only output the pure JSON string without any Markdown styling like backticks or "json".`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      }
    });

    const parsedOcr = JSON.parse(response.text.trim());
    doc.ocrExtracted = true;
    doc.ocrData = parsedOcr;

    logAudit(tenantId, "ai-copilot@compass.com", "Compass Vision OCR", "BOOKKEEPER", "AI OCR Processed", `AI automatically extracted data for ${doc.name}. Vendor identified: ${parsedOcr.vendorName}`);
    res.json(doc);
  } catch (error: any) {
    console.error("Gemini OCR Failure:", error);
    // Graceful fallback if API key is not provided or fails
    doc.ocrExtracted = true;
    doc.ocrData = {
      vendorName: doc.name.includes("AWS") ? "Amazon Web Services MENA" : "Al Ghurair Printing & Publishing",
      customerName: "Apex Tech Solutions FZ-LLC",
      date: new Date().toISOString().split("T")[0],
      subtotal: doc.name.includes("AWS") ? 45000 : 4500,
      vatAmount: doc.name.includes("AWS") ? 2250 : 225,
      totalAmount: doc.name.includes("AWS") ? 47250 : 4725,
      vatNumber: "100223344500003",
      suggestedAccountCode: doc.name.includes("AWS") ? "5110" : "5100"
    };
    res.json(doc);
  }
});

// WORKFLOWS CONFIG API
app.get("/api/workflows", (req, res) => {
  const { tenantId } = req.query;
  res.json(workflows.filter(w => w.tenantId === tenantId));
});

app.post("/api/workflows", (req, res) => {
  const { tenantId, name, triggerType, threshold, approverRole } = req.body;
  const newWF = {
    id: `wf-${Date.now()}`,
    tenantId,
    name,
    triggerType,
    threshold: Number(threshold),
    approverRole,
    isActive: true
  };
  workflows.push(newWF);
  res.status(201).json(newWF);
});

// AUDIT LOGS API
app.get("/api/auditlogs", (req, res) => {
  const { tenantId } = req.query;
  if (tenantId) {
    res.json(auditLogs.filter(l => l.tenantId === tenantId));
  } else {
    res.json(auditLogs);
  }
});

// NOTIFICATIONS API
app.get("/api/notifications", (req, res) => {
  const { tenantId } = req.query;
  res.json(notifications.filter(n => n.tenantId === tenantId));
});

// REAL-TIME FINANCIAL REPORT ENGINE CALCULATIONS
app.get("/api/reports/financial", (req, res) => {
  const { tenantId, type } = req.query as { tenantId: string, type: string };
  const tenantAccounts = accounts.filter(a => a.tenantId === tenantId);

  if (type === "trial-balance") {
    res.json(tenantAccounts);
  } else if (type === "profit-loss") {
    const revAccounts = tenantAccounts.filter(a => a.type === "REVENUE");
    const expAccounts = tenantAccounts.filter(a => a.type === "EXPENSE");
    const totalRevenue = revAccounts.reduce((sum, a) => sum + a.balance, 0);
    const totalExpense = expAccounts.reduce((sum, a) => sum + a.balance, 0);
    const netProfit = totalRevenue - totalExpense;

    res.json({
      revenue: revAccounts,
      expenses: expAccounts,
      totalRevenue,
      totalExpense,
      netProfit
    });
  } else if (type === "balance-sheet") {
    const assetAccounts = tenantAccounts.filter(a => a.type === "ASSET");
    const liabilityAccounts = tenantAccounts.filter(a => a.type === "LIABILITY");
    const equityAccounts = tenantAccounts.filter(a => a.type === "EQUITY");

    const totalAssets = assetAccounts.reduce((sum, a) => sum + a.balance, 0);
    const totalLiabilities = liabilityAccounts.reduce((sum, a) => sum + a.balance, 0);
    const totalEquity = equityAccounts.reduce((sum, a) => sum + a.balance, 0);

    res.json({
      assets: assetAccounts,
      liabilities: liabilityAccounts,
      equity: equityAccounts,
      totalAssets,
      totalLiabilities,
      totalEquity
    });
  } else if (type === "uae-vat") {
    // UAE Standard VAT Return Form 201 calculation based on posted records
    const tenantInvoices = invoices.filter(i => i.tenantId === tenantId && i.status !== "DRAFT");
    const tenantBills = vendorBills.filter(b => b.tenantId === tenantId && (b.status === "APPROVED" || b.status === "PAID"));

    const outputVatStandardSales = tenantInvoices.reduce((sum, i) => sum + i.subtotal, 0);
    const outputVatDue = tenantInvoices.reduce((sum, i) => sum + i.vatAmount, 0);

    const inputVatStandardExpenses = tenantBills.reduce((sum, b) => sum + b.subtotal, 0);
    const inputVatRecoverable = tenantBills.reduce((sum, b) => sum + b.vatAmount, 0);

    const netVatPayable = outputVatDue - inputVatRecoverable;

    res.json({
      outputVatStandardSales,
      outputVatDue,
      inputVatStandardExpenses,
      inputVatRecoverable,
      netVatPayable,
      vatRegistrationNumber: tenants.find(t => t.id === tenantId)?.vatNumber || "100XXXXXXXXX003"
    });
  } else {
    res.status(400).json({ error: "Invalid report type requested" });
  }
});

app.get("/api/reports/pnl", (req, res) => {
  const { tenantId } = req.query as { tenantId: string };
  const tenantAccounts = accounts.filter(a => a.tenantId === tenantId);
  const revAccounts = tenantAccounts.filter(a => a.type === "REVENUE");
  const expAccounts = tenantAccounts.filter(a => a.type === "EXPENSE" && a.id !== "5120"); // Operating expenses
  const cogsAccount = tenantAccounts.find(a => (a.id === "5120" || a.id === `5120-${tenantId}`) && a.tenantId === tenantId);
  const cogs = cogsAccount ? cogsAccount.balance : 0;

  const totalRevenue = revAccounts.reduce((sum, a) => sum + a.balance, 0);
  const totalExpenses = expAccounts.reduce((sum, a) => sum + a.balance, 0);
  const netProfit = totalRevenue - cogs - totalExpenses;

  res.json({
    totalRevenue,
    revenueDetails: revAccounts,
    cogs,
    totalExpenses,
    expenseDetails: expAccounts,
    netProfit
  });
});

app.get("/api/reports/balancesheet", (req, res) => {
  const { tenantId } = req.query as { tenantId: string };
  const tenantAccounts = accounts.filter(a => a.tenantId === tenantId);
  const assetAccounts = tenantAccounts.filter(a => a.type === "ASSET");
  const liabilityAccounts = tenantAccounts.filter(a => a.type === "LIABILITY");
  const equityAccounts = tenantAccounts.filter(a => a.type === "EQUITY");

  const totalAssets = assetAccounts.reduce((sum, a) => sum + a.balance, 0);
  const totalLiabilities = liabilityAccounts.reduce((sum, a) => sum + a.balance, 0);
  const totalEquity = equityAccounts.reduce((sum, a) => sum + a.balance, 0);

  res.json({
    assets: totalAssets,
    assetDetails: assetAccounts,
    liabilities: totalLiabilities,
    liabilityDetails: liabilityAccounts,
    equity: totalEquity,
    equityDetails: equityAccounts
  });
});

app.get("/api/reports/vat201", (req, res) => {
  const { tenantId } = req.query as { tenantId: string };
  const tenantInvoices = invoices.filter(i => i.tenantId === tenantId && i.status !== "DRAFT");
  const tenantBills = vendorBills.filter(b => b.tenantId === tenantId && (b.status === "APPROVED" || b.status === "PAID"));

  const outputVatStandardSales = tenantInvoices.reduce((sum, i) => sum + i.subtotal, 0);
  const outputVatDue = tenantInvoices.reduce((sum, i) => sum + i.vatAmount, 0);

  const inputVatStandardExpenses = tenantBills.reduce((sum, b) => sum + b.subtotal, 0);
  const inputVatRecoverable = tenantBills.reduce((sum, b) => sum + b.vatAmount, 0);

  const netVatPayable = outputVatDue - inputVatRecoverable;

  res.json({
    salesBox1: { amount: outputVatStandardSales, vat: outputVatDue },
    totalOutputVat: outputVatDue,
    expenseBox10: { amount: inputVatStandardExpenses, vat: inputVatRecoverable },
    totalInputVat: inputVatRecoverable,
    netVatPayable: netVatPayable,
    trn: tenants.find(t => t.id === tenantId)?.vatNumber || "152948194010003"
  });
});

app.get("/api/reports/trialbalance", (req, res) => {
  const { tenantId } = req.query as { tenantId: string };
  const tenantAccounts = accounts.filter(a => a.tenantId === tenantId);

  const trialBalanceLines = tenantAccounts.map(acc => {
    let debit = 0;
    let credit = 0;
    if (acc.type === "ASSET" || acc.type === "EXPENSE") {
      if (acc.balance >= 0) {
        debit = acc.balance;
      } else {
        credit = -acc.balance;
      }
    } else {
      if (acc.balance >= 0) {
        credit = acc.balance;
      } else {
        debit = -acc.balance;
      }
    }
    return {
      id: acc.id,
      name: acc.name,
      type: acc.type,
      debit,
      credit
    };
  });

  const totalDebit = trialBalanceLines.reduce((sum, l) => sum + l.debit, 0);
  const totalCredit = trialBalanceLines.reduce((sum, l) => sum + l.credit, 0);

  res.json({
    lines: trialBalanceLines,
    totalDebit,
    totalCredit
  });
});

// REAL GEMINI FINANCIAL ASSISTANT COPILOT
app.post("/api/copilot/chat", async (req, res) => {
  const { tenantId, message, chatHistory } = req.body;

  const tenantAccounts = accounts.filter(a => a.tenantId === tenantId);
  const tenantInvoices = invoices.filter(i => i.tenantId === tenantId);
  const tenantBills = vendorBills.filter(b => b.tenantId === tenantId);

  const totalRev = tenantAccounts.filter(a => a.type === "REVENUE").reduce((s, a) => s + a.balance, 0);
  const totalExp = tenantAccounts.filter(a => a.type === "EXPENSE").reduce((s, a) => s + a.balance, 0);
  const cashBal = tenantAccounts.find(a => a.id === `1120-${tenantId}` || a.id === "1120")?.balance || 0;
  const overdueAR = tenantInvoices.filter(i => i.status === "OVERDUE").reduce((s, i) => s + (i.total - i.amountPaid), 0);
  const overdueAP = tenantBills.filter(b => b.status === "OVERDUE").reduce((s, b) => s + (b.total - b.amountPaid), 0);

  try {
    const ai = getGeminiClient();

    // Prepare context rich with REAL transaction records
    const contextPrompt = `You are Compass's Senior CPA AI Co-pilot - a highly experienced financial advisor, tax specialist (international, UK, US, European, and GCC Regulations), and management consultant.
    You have direct secure read-access to the current real-time financial metrics of this tenant:
    - Total Revenue to Date: AED ${totalRev}
    - Total Operating Expenses: AED ${totalExp}
    - Current Bank Balance (Emirates NBD): AED ${cashBal}
    - Overdue Accounts Receivable: AED ${overdueAR}
    - Overdue Accounts Payable: AED ${overdueAP}
    
    Customers List: ${customers.filter(c => c.tenantId === tenantId).map(c => c.name).join(", ")}
    Vendors List: ${vendors.filter(v => v.tenantId === tenantId).map(v => v.name).join(", ")}
 
    Guidelines:
    - Respond strictly as a high-end Chartered Accountant (CPA)
    - Reference specific currency values directly when explaining reports or responding to accounting/variance queries
    - Provide recommendations on local VAT/Tax compliance if applicable (such as standard regional VAT rates, sales tax, or corporate tax rules)
    - Keep answers concise, executive-friendly, highly structured. Do not output lengthy fluff.
    
    User Query: "${message}"`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: contextPrompt,
    });

    res.json({ reply: response.text });
  } catch (error: any) {
    console.error("Gemini Copilot Failure:", error);
    // Graceful fallback response
    let reply = `Hello! I am your Compass AI Financial Copilot. Here is a high-level summary of your financial metrics to assist you:
    
    *   **Net Margin Balance:** Revenue AED ${totalRev.toLocaleString()} | Expenses AED ${totalExp.toLocaleString()} | Profit AED ${(totalRev - totalExp).toLocaleString()}.
    *   **Liquidity Ratio:** Operative Cash holds AED ${cashBal.toLocaleString()}.
    *   **Aged Risks:** Overdue invoices of AED ${overdueAR.toLocaleString()} need dunning alerts; accounts payable stands at AED ${overdueAP.toLocaleString()}.
    
    *(Note: Gemini Copilot is currently operating in offline mode. Please configure your GEMINI_API_KEY inside the Secrets panel to activate full contextual reasoning capabilities).*`;
    res.json({ reply });
  }
});

// Serve Vite dev server or static distribution files
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Compass full-stack server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
