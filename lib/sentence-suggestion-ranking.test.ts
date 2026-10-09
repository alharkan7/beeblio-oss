import assert from "node:assert/strict";
import test from "node:test";

import { evidenceScore, rankByEvidence } from "./sentence-suggestion-ranking.ts";

const topics = [
  {
    name: "epidemiology",
    claim: "Wastewater surveillance detects changes in SARS-CoV-2 transmission before reported clinical cases rise.",
    relevant: { title: "Wastewater surveillance of SARS-CoV-2", abstract: "Wastewater viral signals preceded reported clinical cases in several cities." },
    unrelated: { title: "Clinical trial of antiviral treatment", abstract: "This trial evaluated treatment among hospitalized patients." },
  },
  {
    name: "molecular machine learning",
    claim: "Explicit chemical bond features improve molecular property prediction in graph neural networks.",
    relevant: { title: "Bond-aware graph neural networks", abstract: "Explicit chemical bond features improved molecular property prediction benchmarks." },
    unrelated: { title: "Graph neural networks for social networks", abstract: "This study predicted friendship links." },
  },
  {
    name: "urban climate",
    claim: "Urban tree canopy lowers daytime surface temperatures in heat-exposed neighborhoods.",
    relevant: { title: "Urban tree canopy and surface temperature", abstract: "Greater canopy cover was associated with lower daytime surface temperatures." },
    unrelated: { title: "Ocean heat and coral bleaching", abstract: "Marine heatwaves affected coral reefs." },
  },
];

for (const topic of topics) {
  test(`ranks supporting evidence first for ${topic.name}`, () => {
    const ranked = rankByEvidence([topic.unrelated, topic.relevant], topic.claim, (item) => item);
    assert.equal(ranked[0], topic.relevant);
    assert.ok(evidenceScore(topic.claim, topic.relevant.title, topic.relevant.abstract) > evidenceScore(topic.claim, topic.unrelated.title, topic.unrelated.abstract));
  });
}

test("high citation count cannot outweigh unrelated evidence", () => {
  const claim = "Wastewater surveillance detects changes in SARS-CoV-2 transmission.";
  const ranked = rankByEvidence([
    { title: "Marine heatwaves", abstract: "Ocean temperatures increased.", citationCount: 20000 },
    { title: "Wastewater SARS-CoV-2 surveillance", abstract: "Wastewater signals tracked transmission.", citationCount: 20 },
  ], claim, (item) => item);
  assert.equal(ranked[0].citationCount, 20);
});
