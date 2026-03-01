#!/usr/bin/env node

/**
 * Clean up Qdrant - delete all collections (vector data)
 */

const http = require("http");

async function cleanupQdrant() {
  const options = {
    hostname: "localhost",
    port: 6333,
    path: "/collections",
    method: "GET",
  };

  console.log("🧹 Cleaning Qdrant...");

  // Get all collections
  const req = http.request(options, (res) => {
    let data = "";
    res.on("data", (chunk) => {
      data += chunk;
    });
    res.on("end", () => {
      const collections = JSON.parse(data).result.collections || [];
      if (collections.length === 0) {
        console.log("✅ Qdrant is already empty");
        return;
      }
      let deleted = 0;
      collections.forEach((col) => {
        const delOptions = {
          hostname: "localhost",
          port: 6333,
          path: `/collections/${col.name}`,
          method: "DELETE",
        };
        const delReq = http.request(delOptions, (delRes) => {
          delRes.on("data", () => {});
          delRes.on("end", () => {
            deleted++;
            if (deleted === collections.length) {
              console.log(`✅ Cleaned! Deleted ${deleted} collections`);
            }
          });
        });
        delReq.on("error", (e) => {
          console.error(`❌ Error deleting collection ${col.name}:`, e.message);
        });
        delReq.end();
      });
    });
  });
  req.on("error", (e) => {
    console.error("❌ Error:", e.message);
  });
  req.end();
}

cleanupQdrant();
