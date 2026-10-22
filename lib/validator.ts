import axios = require("axios");
import log = require("./log");

interface ReadmeAnalysis {
  hasReadme: boolean;
  wordCount: number;
  hasInstructions: boolean;
  hasDemo: boolean;
  hasScreenshots: boolean;
}

interface ValidationResult {
  ok: boolean;
  error?: string;
  url?: string;
  fullName?: string;
  isReady?: boolean;
  passes?: string[];
  issues?: string[];
  tips?: string[];
}
const GITHUB_URL_REGEX =
  /(?:https?:\/\/)?(?:www\.)?github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)(?:\.git)?(?:\/tree\/([^?#\s]+))?/i;

const OPEN_SOURCE_LICENSES = [
  { id: "mit", name: "MIT License", regex: /\bMIT License|\bPermission is hereby granted, free of charge/i },
  { id: "apache-2.0", name: "Apache 2.0", regex: /\bApache License,?\s+Version 2\.0/i },
  { id: "gpl-3.0", name: "GPL v3", regex: /\bGNU GENERAL PUBLIC LICENSE\s+Version 3/i },
  { id: "gpl-2.0", name: "GPL v2", regex: /\bGNU GENERAL PUBLIC LICENSE\s+Version 2/i },
  {
    id: "bsd-3-clause",
    name: "BSD 3-Clause",
    regex: /\bRedistribution and use in source and binary forms|\bBSD 3-Clause/i,
  },
  { id: "bsd-2-clause", name: "BSD 2-Clause", regex: /\bBSD 2-Clause/i },
  {
    id: "isc",
    name: "ISC License",
    regex: /\bPermission to use, copy, modify, and\/or distribute this software for any purpose/i,
  },
  { id: "mpl-2.0", name: "Mozilla Public License 2.0", regex: /\bMozilla Public License\s+v\.\s*2\.0/i },
  {
    id: "unlicense",
    name: "The Unlicense",
    regex: /\bThis is free and unencumbered software released into the public domain/i,
  },
];

function parseGithubUrl(text: string | null | undefined) {
  if (!text) return null;
  const match = String(text).match(GITHUB_URL_REGEX);
  if (!match) return null;
  const treePath = (match[3] || "").replace(/\/+$/, "");
  const treeSegments = treePath ? treePath.split("/") : [];
  // An unescaped slash is ambiguous between a slash-containing branch name and
  // a branch followed by a subdirectory. Do not silently validate the first
  // segment; users can percent-encode a slash-containing ref.
  const encodedSlashRef = /%2f/i.test(treeSegments[0] || "");
  const unsupportedTreePath = treeSegments.length > 1 && !encodedSlashRef;
  let owner = match[1];
  let repo = match[2];
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);
  let branch: string | null = null;
  const rawBranch = treeSegments[0];
  if (rawBranch) {
    try {
      branch = decodeURIComponent(rawBranch);
    } catch {
      branch = rawBranch;
    }
  }
  return {
    owner,
    repo,
    branch,
    unsupportedTreePath,
    fullName: `${owner}/${repo}`,
    url: `https://github.com/${owner}/${repo}`,
  };
}

const DEFAULT_BRANCH_TTL_MS = 5 * 60 * 1000;
const defaultBranchCache = new Map<string, { branch: string; expiresAt: number }>();
const defaultBranchInflight = new Map<string, Promise<string>>();

async function resolveDefaultBranch(owner: string, repo: string): Promise<string> {
  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const cached = defaultBranchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.branch;
  if (cached) defaultBranchCache.delete(key);
  const current = defaultBranchInflight.get(key);
  if (current) return current;

  const lookup = (async () => {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    const token = (process.env.ORRY_GITHUB_TOKEN ?? process.env.RIVET_GITHUB_TOKEN) || process.env.GITHUB_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await axios.get(`https://api.github.com/repos/${owner}/${repo}`, { timeout: 8000, headers });
    const branch = response.data?.default_branch;
    if (response.status !== 200 || typeof branch !== "string" || !branch.trim()) {
      throw new Error("GitHub did not return a default branch");
    }
    defaultBranchCache.set(key, { branch, expiresAt: Date.now() + DEFAULT_BRANCH_TTL_MS });
    return branch;
  })();
  defaultBranchInflight.set(key, lookup);
  try {
    return await lookup;
  } finally {
    if (defaultBranchInflight.get(key) === lookup) defaultBranchInflight.delete(key);
  }
}

async function fetchRawFile(owner: string, repo: string, filename: string, branch: string) {
  const branchPath = branch
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branchPath}/${filename}`;
  const res = await axios.get(url, { timeout: 8000 });
  if (res.status === 200 && typeof res.data === "string") return res.data;
  return null;
}

function detectLicense(content: string | null) {
  if (!content || !content.trim()) return null;
  for (const lic of OPEN_SOURCE_LICENSES) {
    if (lic.regex.test(content)) return lic.name;
  }
  return "Custom / Unknown Open Source License";
}

function analyzeReadme(readmeText: string | null): ReadmeAnalysis {
  if (!readmeText || !readmeText.trim()) {
    return {
      hasReadme: false,
      wordCount: 0,
      hasInstructions: false,
      hasDemo: false,
      hasScreenshots: false,
    };
  }

  const words = readmeText.trim().split(/\s+/).length;
  const hasInstructions =
    /\b(?:run|build|install|setup|start|usage|getting started|how to|npm (?:run|install|start)|cargo build|python|pip install|yarn|pnpm|make)\b/i.test(
      readmeText,
    );
  const hasDemo =
    /\b(?:demo|live|video|youtube\.com|youtu\.be|loom\.com|playable|deployed|website|vercel\.app|netlify\.app|github\.io)\b/i.test(
      readmeText,
    );
  const hasScreenshots = /\.(?:png|jpe?g|gif|webp|svg)\b|!\[.*?\]\(.*?\)|<img\s+[^>]*src=/i.test(readmeText);

  return {
    hasReadme: true,
    wordCount: words,
    hasInstructions,
    hasDemo,
    hasScreenshots,
  };
}

async function validateRepository(
  ownerOrUrl: string,
  repoName: string | null = null,
  requestedBranch: string | null = null,
) {
  let owner = ownerOrUrl;
  let repo = repoName || "";
  let branch = requestedBranch;

  if (!repoName) {
    const parsed = parseGithubUrl(ownerOrUrl);
    if (!parsed) return { ok: false, error: "Could not parse a valid GitHub repository URL." };
    owner = parsed.owner;
    repo = parsed.repo;
    if (parsed.unsupportedTreePath) {
      return {
        ok: false,
        error:
          "Could not validate a nested GitHub tree URL. Use the repository root or a /tree/<branch> URL; percent-encode slashes in branch names.",
      };
    }
    branch ||= parsed.branch;
  }

  if (!branch) {
    try {
      branch = await resolveDefaultBranch(owner, repo);
    } catch (error: unknown) {
      return {
        ok: false,
        error: `Could not determine the default branch for ${owner}/${repo}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const [license, readme] = await Promise.all([
    fetchFirstHit(owner, repo, branch, [
      "LICENSE",
      "LICENSE.md",
      "LICENSE.txt",
      "COPYING",
      "LICENSE-MIT",
      "LICENSE-APACHE",
    ]),
    fetchFirstHit(owner, repo, branch, ["README.md", "README", "readme.md", "Readme.md"]),
  ]);
  const { text: licenseText, file: matchedLicenseFile } = license;
  const { text: readmeText, file: matchedReadmeFile } = readme;

  const licenseName = licenseText ? detectLicense(licenseText) : null;
  const readmeAnalysis = analyzeReadme(readmeText);

  return {
    ok: true,
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    url: `https://github.com/${owner}/${repo}`,
    license: {
      found: Boolean(licenseText),
      name: licenseName,
      file: matchedLicenseFile,
    },
    readme: {
      found: readmeAnalysis.hasReadme,
      file: matchedReadmeFile,
      ...readmeAnalysis,
    },
    ...assessReadiness({ licenseName, matchedLicenseFile, readmeAnalysis }),
  };
}

async function fetchFirstHit(owner: string, repo: string, branch: string, filenames: string[]) {
  for (const fn of filenames) {
    try {
      const text = await fetchRawFile(owner, repo, fn, branch);
      if (text) return { text, file: fn };
    } catch {
      // Missing alternate filenames are normal while checking optional files.
    }
  }
  return { text: null, file: null };
}

function assessReadiness({
  licenseName,
  matchedLicenseFile,
  readmeAnalysis,
}: {
  licenseName: string | null;
  matchedLicenseFile: string | null;
  readmeAnalysis: ReadmeAnalysis;
}) {
  const issues = [];
  const passes = [];
  const tips = [];

  if (licenseName) {
    passes.push(`License found: *${licenseName}* (${matchedLicenseFile})`);
  } else {
    issues.push(`*Missing open-source LICENSE!* The program requires an open-source license (like MIT or Apache 2.0).`);
  }

  if (readmeAnalysis.hasReadme) {
    if (readmeAnalysis.wordCount >= 30) {
      passes.push(`README.md is well-documented (${readmeAnalysis.wordCount} words)`);
    } else {
      tips.push(
        `README.md is very brief (${readmeAnalysis.wordCount} words). Add a couple sentences describing what your project does.`,
      );
    }

    if (readmeAnalysis.hasInstructions) {
      passes.push(`Build and setup instructions detected in README`);
    } else {
      tips.push(`Add step-by-step build or run instructions (e.g. how reviewers can test your code).`);
    }

    if (readmeAnalysis.hasDemo || readmeAnalysis.hasScreenshots) {
      passes.push(`Demo link / screenshots detected in README`);
    } else {
      tips.push(`Add a screenshot, GIF, or demo link in your README to speed up reviewer approval.`);
    }
  } else {
    issues.push(`*Missing README.md file!* Add a README explaining what your project is and how to run it.`);
  }

  return { isReady: issues.length === 0, passes, issues, tips };
}

function formatValidationReport(result: ValidationResult | null) {
  if (!result || !result.ok) {
    return result?.error || "Could not inspect GitHub repository.";
  }

  const lines = [
    `*Program Submission Check for <${result.url}|${result.fullName}>:*`,
    "",
    result.isReady
      ? `🎉 *Ready for submission!* Everything looks solid for reviewer review.`
      : `⚠️ *Almost there!* A few items need attention before submitting:`,
    "",
  ];

  if (result.passes && result.passes.length > 0) {
    lines.push("*What looks good:*");
    for (const p of result.passes) lines.push(`• ✅ ${p}`);
    lines.push("");
  }

  if (result.issues && result.issues.length > 0) {
    lines.push("*Action items to fix:*");
    for (const item of result.issues) lines.push(`• 🔴 ${item}`);
    lines.push("");
  }

  if (result.tips && result.tips.length > 0) {
    lines.push("*Reviewer approval tips:*");
    for (const tip of result.tips) lines.push(`• 💡 ${tip}`);
    lines.push("");
  }

  return lines.join("\n").trim();
}

export = {
  parseGithubUrl,
  validateRepository,
  resolveDefaultBranch,
  formatValidationReport,
  detectLicense,
  analyzeReadme,
  fetchFirstHit,
  assessReadiness,
};
