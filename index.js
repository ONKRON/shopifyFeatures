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
  let { name, country } = req.query;

  if (!name || !country)
    return res.status(400).json({ error: "Missing parameters" });

  name = decodeURIComponent(name).trim();

  const sql = `
    SELECT 
      b.specification_name,
      b.specification_suffix,
      a.specification,
      a.specifications_id,
      a.products_specification_id
    FROM 
      products_specifications AS a
    JOIN specification_description AS b ON b.specifications_id = a.specifications_id
    JOIN specifications AS c ON c.specifications_id = a.specifications_id
    JOIN products_description AS d ON d.products_id = a.products_id
    WHERE 
      d.products_name = ? AND
      b.language_id = ? AND
      a.language_id = ? AND
      c.show_data_sheet = 'True'
    ORDER BY c.specification_sort_order ASC
  `;

  const values = [name, country, country];

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

  const DEFAULT_SPECIFICATION_IDS = [22, 24, 709, 786];
  const SPECIFICATION_FIELDS = {
    709: "diagonal_min",
    22: "diagonal_max",
    24: "vesa",
    786: "max_load",
  };
  const CATEGORY_TYPES = {
    "Потолочные кронштейны": "Celling",
    "Настенные кронштейны": "Wall",
    "Стойки для телевизоров": "Floor",
    "Настольные кронштейны": "Desktop",
    "Кронштейны для проекторов": "Projector",
    "Товары для дома": "Home",
  };
  const ALLOWED_CATEGORY_TYPES = new Set([
    "Floor",
    "Wall",
    "Celling",
    "Desktop",
  ]);
  const EXCLUDED_CATEGORY_TYPES = new Set([]);

  function formatSpecificationValue(value) {
    const trimmedValue = value.trim();
    const normalizedNumber = trimmedValue.replace(",", ".");

    if (/^[+-]?\d+(\.\d+)?$/.test(normalizedNumber)) {
      return Number(normalizedNumber);
    }

    return trimmedValue;
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
      c.products_type
    FROM products_specifications AS a
    JOIN products AS p
      ON p.products_id = a.products_id
    LEFT JOIN products_to_categories AS pc
      ON pc.products_id = a.products_id
    LEFT JOIN categories AS c
      ON c.categories_id = pc.categories_id
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
          category: "",
          categoryTypes: [],
          isExcludedCategory: false,
        });
      }

      const product = productsMap.get(row.products_id);
      const rawCategory = row.products_type?.trim();
      const category = CATEGORY_TYPES[rawCategory] || rawCategory;

      if (EXCLUDED_CATEGORY_TYPES.has(category)) {
        product.isExcludedCategory = true;
      }

      if (
        category &&
        category !== "0" &&
        ALLOWED_CATEGORY_TYPES.has(category) &&
        !product.categoryTypes.includes(category)
      ) {
        product.categoryTypes.push(category);
        product.category = product.categoryTypes.join(", ");
      }

      const fieldName =
        SPECIFICATION_FIELDS[row.specifications_id] ||
        `spec_${row.specifications_id}`;
      const value = formatSpecificationValue(row.specification);

      if (fieldName === "vesa") {
        if (!product.vesa) product.vesa = [];
        if (!product.vesa.includes(value)) product.vesa.push(value);
      } else if (!product[fieldName]) {
        product[fieldName] = value;
      }
    }

    const products = Array.from(productsMap.values())
      .filter(({ categoryTypes, isExcludedCategory }) => {
        return categoryTypes.length && !isExcludedCategory;
      })
      .map(({ categoryTypes, isExcludedCategory, ...product }) => product);

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
