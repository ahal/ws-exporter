import { isValid, parse } from 'date-fns';

type ParsedTransactions = Array<Record<string, number | string | undefined | null> | undefined>;

/**
 * Examples:
 * 1. Account: Cash
 * 2. Date: July 10, 202411:35 pm -> The date and time are in different lines, but getting textContent will return them in a single line
 * 3. Exchange Rate: 1.4795
 * 4. Original Amount: − 20.00 EUR
 * 5. Spend Rewards: + $0.30 CAD
 * 6. Status: Completed
 * 7. Total: − $29.59 CAD
 */
function parseRow(name: string, value?: string) {
  const normalizedName = name.toLowerCase();
  
  const parseCurrencyValue = (value: string) => {
    // Matches currency values with optional sign, currency symbol, and ISO code
    // Examples: "− $2.30", "$10.30", "+ $5.00 CAD", "− 20.00 EUR"
    const match = value.match(/^([+−-])?\s*\$?([\d,]+(?:\.\d{2})?)\s*([A-Z]{3})?$/);
    if (!match) {
      console.warn(`Failed to parse currency value: "${value}"`);
      return { amount: null, currency: undefined };
    }
    
    const sign = match[1] === '−' || match[1] === '-' ? -1 : 1;
    const amount = parseFloat(match[2].replace(',', ''));
    const currency = match[3] || undefined; // Explicit currency code required
    
    return { amount: amount * sign, currency };
  };
  if (normalizedName === 'account') {
    return { account: value };
  }
  if (normalizedName === 'to') {
    return { to: value };
  }
  if (normalizedName === 'from') {
    return { from: value };
  }
  if (normalizedName === 'status') {
    return { status: value };
  }
  if (normalizedName === 'date') {
    if (!value) {
      return {};
    }
    
    // Normalize whitespace and ensure proper formatting
    const normalizedValue = value
      .replace(/\s+/g, ' ')
      .replace(/(\d{4})\s*(\d)/, '$1 $2')
      .trim();

    // Try multiple date formats in order of specificity
    const dateFormats = [
      'MMMM d, yyyy h:mm a',   // Standard with space
      'MMMM d, yyyyh:mm a',    // Legacy without space
      'MMMM d, yyyy'           // Date only
    ];
    
    for (const format of dateFormats) {
      const parsedDate = parse(normalizedValue, format, new Date());
      if (isValid(parsedDate)) {
        return { date: parsedDate.toISOString().split('T')[0] };
      }
    }
    
    console.warn(`Failed to parse date: "${value}"`);
    return {};
  }
  if (normalizedName === 'original amount') {
    if (!value) {
      return {};
    }
    const parsed = parseCurrencyValue(value);
    if (parsed.amount === null) {
      console.warn(`Invalid original amount: "${value}"`);
      return {};
    }
    return { originalAmount: parsed.amount, originalCurrency: parsed.currency };
  }
  if (normalizedName === 'exchange rate') {
    if (!value) {
      return {};
    }
    return { exchangeRate: parseFloat(value) };
  }
  if (normalizedName === 'total' || normalizedName === 'amount') {
    if (!value) {
      return {};
    }
    const parsed = parseCurrencyValue(value);
    if (parsed.amount === null) {
      console.warn(`Invalid total/amount: "${value}"`);
      return {};
    }
    return { total: parsed.amount, totalCurrency: parsed.currency };
  }
  if (normalizedName.indexOf('spend rewards') > -1) {
    if (!value) {
      return {};
    }
    const parsed = parseCurrencyValue(value);
    if (parsed.amount === null) {
      console.warn(`Invalid spend rewards: "${value}"`);
      return {};
    }
    return { spendRewards: parsed.amount, spendRewardsCurrency: parsed.currency };
  }
  if (normalizedName === 'type' || normalizedName === 'transaction type') {
    return { transactionType: value };
  }
  if (normalizedName === 'transaction id' || normalizedName === 'id') {
    return { transactionId: value };
  }
  if (normalizedName === 'message' || normalizedName === 'note') {
    return { message: value };
  }
  return {};
}

/**
 * Extracts the transaction description from the transaction details container element
 * @param element The transaction details container element
 */
function getTransactionDescription(element: Element) {
  // From the transaction details we find again the header button which contains the name/description
  const transactionHeaderExp = '../child::*[1]/child::*[1]/child::*[1]/child::*[1]/child::*[2]/child::*[1]';
  const transactionHeader = document.evaluate(
    transactionHeaderExp,
    element,
    null,
    XPathResult.FIRST_ORDERED_NODE_TYPE,
    null,
  ).singleNodeValue;
  const description = transactionHeader?.textContent;

  return description;
}

function processTransactionDetails(element: Element): ParsedTransactions[number] {
  let rows = [];
  for (let i = 0; i < element.children[0]?.children?.length ?? 0; i++) {
    // Will have 2 children for name/value for most cases. For interac transfers, there will be another level which is handled
    // by the else block
    const row = element.children[0].children[i];
    if (row.children.length === 2 && row.children[0].textContent) {
      rows.push(row);
    } else {
      const result = [];
      for (let i = 0; i < row.children.length; i++) {
        if (row.children[i].children.length === 2 && row.children[i].children[0].textContent) {
          result.push(row.children[i]);
        }
      }
      rows.push(result);
    }
  }
  rows = rows.flat();
  if (!rows || rows.length === 0) {
    return;
  }

  let rowData: ParsedTransactions[number] = {};

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    if (row.children.length !== 2 || !row.children[0].textContent) {
      continue;
    }
    
    // Extract only the first text node or first child's text to avoid concatenating nested elements
    const valueElement = row.children[1];
    let value: string | undefined;
    
    // If the element has child elements, get only the first child's text
    if (valueElement.children.length > 0) {
      value = valueElement.children[0].textContent ?? undefined;
    } else {
      // Otherwise use the direct text content
      value = valueElement.textContent ?? undefined;
    }
    
    rowData = { ...rowData, ...parseRow(row.children[0].textContent, value) };
  }

  if (Object.keys(rowData).length === 0) {
    return;
  }

  if (!rowData.account && (rowData.to || rowData.from)) {
    rowData = { ...rowData, account: ((rowData.total as number) ?? 0) < 0 ? rowData.from : rowData.to };
  }
  
  // Determine the payee based on transaction direction and available fields
  let payee: string | undefined;
  const description = getTransactionDescription(element);
  const total = rowData.total as number;
  
  // For transfers, use the counterparty (not the account we're viewing)
  if (rowData.from && rowData.to) {
    // If we have both from and to, pick the one that's NOT the account
    if (rowData.account === rowData.from) {
      payee = String(rowData.to);
    } else if (rowData.account === rowData.to) {
      payee = String(rowData.from);
    } else {
      // If account doesn't match either, use the opposite of money flow
      payee = String(total < 0 ? rowData.to : rowData.from);
    }
  } else if (rowData.from) {
    payee = String(rowData.from);
  } else if (rowData.to) {
    payee = String(rowData.to);
  }
  
  // If we still don't have a payee, use the description (for purchases, etc.)
  if (!payee && description) {
    payee = description;
  }
  
  // Handle WealthSimple-specific transactions 
  let wealthsimpleType: string | undefined;
  if (payee && ['Bonus', 'Interest', 'Cash back'].includes(payee)) {
    wealthsimpleType = payee;
    payee = 'WealthSimple';
  }
  
  // Create Notes column with transaction type, ID, message, and rewards
  let notes: string[] = [];
  
  // Add WealthSimple transaction type or regular transaction type and ID
  if (wealthsimpleType) {
    notes.push(wealthsimpleType);
  } else if (rowData.transactionType || rowData.transactionId) {
    const typeAndId = [
      rowData.transactionType || '',
      rowData.transactionId || ''
    ].filter(Boolean).join(' - ');
    if (typeAndId) notes.push(typeAndId);
  }
  
  // Add message
  if (rowData.message) {
    notes.push(String(rowData.message));
  }
  
  // Add rewards information
  if (rowData.spendRewards && rowData.spendRewardsCurrency) {
    notes.push(`earned ${rowData.spendRewards}${rowData.spendRewardsCurrency}`);
  }
  
  // Clean up the rowData to only include needed fields
  const cleanedData: ParsedTransactions[number] = {
    status: rowData.status,
    date: rowData.date,
    total: rowData.total,
    totalCurrency: rowData.totalCurrency,
    account: rowData.account,
    payee: payee,
    notes: notes.length > 0 ? notes.join('; ') : undefined,
  };
  
  // Add optional fields if they exist
  if (rowData.originalAmount) cleanedData.originalAmount = rowData.originalAmount;
  if (rowData.originalCurrency) cleanedData.originalCurrency = rowData.originalCurrency;
  if (rowData.exchangeRate) cleanedData.exchangeRate = rowData.exchangeRate;
  
  return cleanedData;
}

function parsedTransactionsToCsv(parsed: ParsedTransactions) {
  const items = parsed.filter(Boolean).sort((a, b) => {
    if (!a?.date || !b?.date) {
      return 0;
    }
    return new Date(a.date).getTime() - new Date(b.date).getTime();
  });

  const replacer = (_key: string, value: unknown) => (value === null || value === undefined ? '' : value);
  
  // Define fixed header order for better readability
  const primaryHeaders = ['date', 'payee', 'account', 'total', 'totalCurrency', 'status', 'notes'];
  const optionalHeaders = ['originalAmount', 'originalCurrency', 'exchangeRate'];
  
  // Find which optional headers are actually present in the data
  const presentOptionalHeaders = optionalHeaders.filter(header => 
    items.some(item => item && item[header] !== undefined)
  );
  
  const headers = [...primaryHeaders, ...presentOptionalHeaders];

  const csv = [
    headers.join(','), // header row first
    ...items.map(row => headers.map(fieldName => JSON.stringify(row?.[fieldName], replacer)).join(',')),
  ].join('\r\n');

  return csv;
}

/**
 * Exports the transactions to a CSV file
 */
async function downloadCsv(filename: string, csv: string) {
  const pom = document.createElement('a');
  pom.setAttribute('href', 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv));
  pom.setAttribute('download', filename);

  if (document.createEvent) {
    const event = document.createEvent('MouseEvents');
    event.initEvent('click', true, true);
    pom.dispatchEvent(event);
  } else {
    pom.click();
  }
}

export async function exportTransactions() {
  // Find the transaction details are which seems to have a role of region
  const role = 'region';
  const roleElement = document.querySelectorAll(`[role="${role}"]`);
  const result: ParsedTransactions = Array.from(roleElement).map(processTransactionDetails);
  const csv = parsedTransactionsToCsv(result);
  await downloadCsv(`ws-exporter-${new Date().toISOString()}.csv`, csv);
}
