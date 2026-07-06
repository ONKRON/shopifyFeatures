const express = require("express");
const dotenv = require("dotenv");
const mysql = require("mysql2/promise");
const cors = require("cors");

const app = express();
const port = 3000;

dotenv.config();

const allowed = new Set([
  "https://onkron.pl",
  "https://onkron.us",
  "https://onkron.de",
  "https://onkron-uk.co.uk",
  "https://onkron.fr",
  "https://onkron.it",
  "https://onkron.es",
]);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowed.has(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);

const pool = mysql.createPool({
  host: process.env.host,
  user: process.env.user,
  password: process.env.password,
  database: process.env.database,
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 20000,
});

app.get("/short", async (req, res) => {
  let { name, country } = req.query;

  if (!name || !country) {
    return res.status(400).json({ error: "Missing name" });
  }

  name = decodeURIComponent(name).trim();

  const sql = `
    SELECT *
    FROM products_description
    WHERE products_name = ? AND language_id = ?
  `;

  const values = [name, country];

  try {
    const [rows] = await pool.query(sql, values);

    if (rows.length === 0) {
      return res.status(404).json({
        error: "Description not found for given name",
      });
    }

    res.json({
      description: rows[0].products_short_description,
    });
  } catch (err) {
    console.error("DB error:", err, values);
    return res.status(500).json({ error: "Database error" });
  }
});

app.get("/chars", async (req, res) => {
  let { name, model, product_id, country } = req.query;

  if ((!name && !model && !product_id) || !country)
    return res.status(400).json({ error: "Missing parameters" });

  const productRef = model || name;
  if (productRef) {
    model = decodeURIComponent(productRef).trim();
  }

  if (product_id) {
    product_id = Number(product_id);
    if (!Number.isInteger(product_id)) {
      return res.status(400).json({ error: "Invalid product_id" });
    }
  }

  const productFilter = product_id ? "a.products_id = ?" : "p.products_model = ?";

  const sql = `
    SELECT 
      b.specification_name,
      b.specification_suffix,
      a.specification,
      a.specifications_id,
      a.products_specification_id
    FROM 
      products_specifications AS a
    JOIN products AS p ON p.products_id = a.products_id
    JOIN specification_description AS b ON b.specifications_id = a.specifications_id
    JOIN specifications AS c ON c.specifications_id = a.specifications_id
    WHERE 
      b.language_id = ? AND
      a.language_id = ? AND
      p.products_status = 1 AND
      ${productFilter} AND
      c.show_data_sheet = 'True'
    ORDER BY c.specification_sort_order ASC
  `;

  const values = [country, country, product_id || model];

  const LANGUAGE_LOCALE_MAP = {
    1: "ru-RU",
    2: "en-US",
    3: "fr-FR",
    4: "it-IT",
    5: "es-ES",
    6: "de-DE",
    7: "pl-PL",
  };

  const locale = LANGUAGE_LOCALE_MAP[country] || "en-US";
  const VOLUME_IDS = new Set([763]);
  const VESA_IDS = new Set([24]);

  function formatVolume(raw, locale = "en-US") {
    if (!raw) return raw;
    let numStr = raw.replace(/[^\d.,]/g, "").replace(",", ".");
    let num = parseFloat(numStr);
    if (isNaN(num)) return raw;
    if (num > 1000) num = num / 1_000_000;
    return num.toLocaleString(locale, {
      minimumFractionDigits: 6,
      maximumFractionDigits: 6,
    });
  }

  try {
    const [rows] = await pool.query(sql, values);
    if (!rows.length)
      return res.status(404).json({ error: "Характеристики не найдены" });

    const grouped = {};

    // Формируем уникальные значения
    for (const row of rows) {
      const specName = row.specification_name?.trim();
      const specValue = row.specification?.trim();
      const suffix = row.specification_suffix?.trim() || "";
      const specId = row.specifications_id;
      const specIndex = row.products_specification_id;

      if (!specValue || specValue === "Array") continue;

      if (!grouped[specName]) {
        grouped[specName] = { valuesMap: new Map(), suffix, specId };
      }

      if (!grouped[specName].valuesMap.has(specValue)) {
        grouped[specName].valuesMap.set(specValue, specIndex);
      }
    }

    // Генерация HTML
    let html = '<div class="new_listing_table">';
    for (const [name, data] of Object.entries(grouped)) {
      let valuesArray = Array.from(data.valuesMap.entries()).map(
        ([value, index]) => ({ value, index }),
      );

      if (VOLUME_IDS.has(data.specId)) {
        valuesArray = valuesArray.map((v) => ({
          ...v,
          value: formatVolume(v.value, locale),
        }));
      }

      if (VESA_IDS.has(data.specId)) {
        valuesArray.sort((a, b) => (a.index || 0) - (b.index || 0));
      } else {
        valuesArray.sort((a, b) => a.value.localeCompare(b.value));
      }

      const valueString =
        valuesArray.map((v) => v.value).join(", ") +
        (data.suffix ? " " + data.suffix : "");

      html += `
        <div class="new_listing_table_row">
          <div class="new_listing_table_left">${name}</div>
          <div class="new_listing_table_right" style="line-height: 24.4px;">
            ${valueString}
          </div>
        </div>`;
    }

    html += '<div class="clear"></div></div>';
    res.json({ table: html });
  } catch (err) {
    console.error("DB error:", err, values);
    res.status(500).json({ error: "Database error" });
  }
});

app.get("/specifications", async (req, res) => {
  let { name, model, product_id, country, specification_ids } = req.query;

  const DEFAULT_SPECIFICATION_IDS = [22, 24, 709, 786, 789];
  const SPECIFICATION_FIELDS = {
    709: "diagonal_min",
    22: "diagonal_max",
    24: "vesa",
    786: "max_load",
    789: "curved_monitor",
  };
  const CATEGORY_MAP = {
    floor: [5],
    wall: [1],
    ceiling: [2],
    desktop: [3],
  };
  const SUBCATEGORY_MAP = {
    wall: {
      Fixed: [6],
      Tilting: [7],
      "Full-motion": [8],
    },
    floor: {
      Interior: [49],
      Mobile: [133],
      Motorized: [161],
    },
    desktop: {
      Monitor: [145, 38, 39, 40, 43, 41],
      "Retractable mount": [134],
      "Desktop TV stand": [45],
    },
  };
  const MONITOR_CATEGORY_MAP = {
    Single: [38],
    Dual: [39],
    "Three plus": [40],
  };
  const CATEGORY_PRIORITY = ["desktop", "wall", "ceiling", "floor"];

  function formatSpecificationValue(value) {
    const trimmedValue = value.trim();
    const normalizedNumber = trimmedValue.replace(",", ".");

    if (/^[+-]?\d+(\.\d+)?$/.test(normalizedNumber)) {
      return Number(normalizedNumber);
    }

    return trimmedValue;
  }

  function formatCurvedMonitorValue(value) {
    const normalizedValue = value.trim().toLowerCase();

    if (["да", "yes", "true", "1"].includes(normalizedValue)) {
      return "Yes";
    }

    if (["нет", "no", "false", "0"].includes(normalizedValue)) {
      return "No";
    }

    return value.trim();
  }

  function hasCategoryId(categoryIds, ids) {
    return ids.some((id) => categoryIds.has(id));
  }

  function findMatchingLabels(categoryIds, categoryMap) {
    return Object.entries(categoryMap)
      .filter(([, ids]) => hasCategoryId(categoryIds, ids))
      .map(([label]) => label);
  }

  function resolveCategory(categoryIds) {
    const category = CATEGORY_PRIORITY.find((type) => {
      const subcategories = SUBCATEGORY_MAP[type] || {};
      const subcategoryIds = Object.values(subcategories).flat();

      return (
        hasCategoryId(categoryIds, CATEGORY_MAP[type] || []) ||
        hasCategoryId(categoryIds, subcategoryIds)
      );
    });

    if (!category) return null;

    const subcategories = findMatchingLabels(
      categoryIds,
      SUBCATEGORY_MAP[category] || {},
    );
    const monitorCategories =
      category === "desktop"
        ? findMatchingLabels(categoryIds, MONITOR_CATEGORY_MAP)
        : [];

    return {
      category,
      subcategory: subcategories.join(", "),
      monitor_category: monitorCategories.join(", "),
    };
  }

  const languageId = country || 1;
  const specificationIds = specification_ids
    ? specification_ids
        .split(",")
        .map((id) => Number(id.trim()))
        .filter((id) => Number.isInteger(id))
    : DEFAULT_SPECIFICATION_IDS;

  if (!specificationIds.length) {
    return res.status(400).json({ error: "Missing specification_ids" });
  }

  const where = [
    "a.language_id = ?",
    "a.specification IS NOT NULL",
    "TRIM(a.specification) <> ''",
    "a.specification <> 'Array'",
    `a.specifications_id IN (${specificationIds.map(() => "?").join(", ")})`,
  ];
  const values = [languageId, ...specificationIds];

  const productModel = model || name;

  if (productModel) {
    const decodedModel = decodeURIComponent(productModel).trim();
    where.push("p.products_model = ?");
    values.push(decodedModel);
  }

  if (product_id) {
    where.push("a.products_id = ?");
    values.push(product_id);
  }

  const sql = `
    SELECT
      a.products_id,
      p.products_model,
      a.specification,
      a.specifications_id,
      a.products_specification_id,
      pc.categories_id
    FROM products_specifications AS a
    JOIN products AS p
      ON p.products_id = a.products_id
    LEFT JOIN products_to_categories AS pc
      ON pc.products_id = a.products_id
    WHERE ${where.join(" AND ")}
    ORDER BY a.products_id ASC, a.products_specification_id ASC
  `;
  const queryValues = values;

  try {
    const [rows] = await pool.query(sql, queryValues);
    const productsMap = new Map();

    for (const row of rows) {
      if (!productsMap.has(row.products_id)) {
        productsMap.set(row.products_id, {
          product: row.products_model,
          categoryIds: new Set(),
        });
      }

      const product = productsMap.get(row.products_id);
      if (row.categories_id) {
        product.categoryIds.add(Number(row.categories_id));
      }

      const fieldName =
        SPECIFICATION_FIELDS[row.specifications_id] ||
        `spec_${row.specifications_id}`;
      const value =
        fieldName === "curved_monitor"
          ? formatCurvedMonitorValue(row.specification)
          : formatSpecificationValue(row.specification);

      if (fieldName === "vesa") {
        if (!product.vesa) product.vesa = [];
        if (!product.vesa.includes(value)) product.vesa.push(value);
      } else if (!product[fieldName]) {
        product[fieldName] = value;
      }
    }

    const products = Array.from(productsMap.values())
      .map(({ categoryIds, product, ...specifications }) => {
        const category = resolveCategory(categoryIds);
        if (!category) return null;

        const responseProduct = {
          product,
          category: category.category,
        };

        if (category.subcategory) {
          responseProduct.subcategory = category.subcategory;
        }

        if (category.monitor_category) {
          responseProduct.monitor_category = category.monitor_category;
        }

        return {
          ...responseProduct,
          ...specifications,
        };
      })
      .filter(Boolean);

    res.json({
      count: products.length,
      products,
    });
  } catch (err) {
    console.error("DB error:", err, queryValues);
    res.status(500).json({ error: "Database error" });
  }
});

app.listen(port, () => {
  console.log("Server working on:", port);
});
