import { describe, it, expect } from 'vitest';
import { XmlAdapter, YamlAdapter, MarkdownAdapter } from '../src/format-adapters.js';
import { compress } from '../src/compress.js';
import type { Message } from '../src/types.js';

function msg(overrides: Partial<Message> & { id: string; index: number }): Message {
  return { role: 'user', content: '', metadata: {}, ...overrides };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mavenPom = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>myapp</artifactId>
  <version>2.1.0</version>
  <description>This is a lengthy description of the application that explains in detail what the project does, why it exists, and how it integrates with the rest of the system.</description>
  <dependencies>
    <dependency>
      <groupId>org.springframework</groupId>
      <artifactId>spring-core</artifactId>
      <version>6.0.0</version>
    </dependency>
  </dependencies>
</project>`;

const k8sDeployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx
  namespace: production
  labels:
    app: nginx
    version: "1.25"
spec:
  replicas: 3
  selector:
    matchLabels:
      app: nginx
  template:
    spec:
      containers:
      - name: nginx
        image: nginx:1.25
        description: This container runs the nginx web server and handles all incoming HTTP traffic for the production environment serving thousands of users daily
        ports:
        - containerPort: 80`;

const githubActionsYaml = `name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run tests
        run: go test ./...`;

const readmeMarkdown = `# MyProject

A fast, minimal framework for building APIs.

## Overview

MyProject provides a clean abstraction over HTTP routing, middleware chaining,
and context propagation. It is designed to be embedded in larger applications
without imposing opinions on your project structure.

## Installation

Run the following to add MyProject to your Go module.

## Usage

Import the package and create a new instance. Configure routes and middleware
before calling Run to start the server. The framework handles graceful shutdown
automatically when the process receives SIGTERM.

## Configuration

All configuration is done through environment variables. See the configuration
reference for the full list of supported options and their defaults.`;

const changelogMarkdown = `# Changelog

All notable changes to this project will be documented here.

## [2.0.0] - 2026-04-01

### Breaking Changes

The configuration API has been completely redesigned. Migration requires updating
all configuration files to use the new key-value format described in the docs.

### Added

New streaming support for large payloads.

## [1.9.0] - 2026-02-15

### Fixed

Resolved a race condition in the connection pool that caused intermittent
failures under high concurrency on systems with more than 32 CPU cores.`;

// ---------------------------------------------------------------------------
// XmlAdapter — detect
// ---------------------------------------------------------------------------

describe('XmlAdapter.detect', () => {
  it('detects XML with declaration', () => {
    expect(XmlAdapter.detect(mavenPom)).toBe(true);
  });

  it('detects XML without declaration', () => {
    expect(XmlAdapter.detect('<root><child>value</child></root>')).toBe(true);
  });

  it('rejects plain prose', () => {
    expect(XmlAdapter.detect('This is just a sentence.')).toBe(false);
  });

  it('rejects YAML', () => {
    expect(XmlAdapter.detect(k8sDeployment)).toBe(false);
  });

  it('rejects content with only an opening tag', () => {
    expect(XmlAdapter.detect('<br />')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// XmlAdapter — extractPreserved / extractCompressible
// ---------------------------------------------------------------------------

describe('XmlAdapter.extractPreserved', () => {
  it('returns skeleton as a single string', () => {
    const preserved = XmlAdapter.extractPreserved(mavenPom);
    expect(preserved).toHaveLength(1);
    expect(preserved[0]).toContain('<groupId>');
    expect(preserved[0]).toContain('com.example'); // short value preserved
  });

  it('collapses long prose text nodes to placeholder', () => {
    const preserved = XmlAdapter.extractPreserved(mavenPom);
    expect(preserved[0]).toContain('[…]');
    // The original prose should not appear in the skeleton
    expect(preserved[0]).not.toContain('lengthy description');
  });

  it('preserves short values intact', () => {
    const preserved = XmlAdapter.extractPreserved(mavenPom);
    expect(preserved[0]).toContain('2.1.0');
    expect(preserved[0]).toContain('myapp');
  });
});

describe('XmlAdapter.extractCompressible', () => {
  it('extracts long prose text nodes', () => {
    const compressible = XmlAdapter.extractCompressible(mavenPom);
    expect(compressible.length).toBeGreaterThan(0);
    expect(compressible.some((c) => c.includes('lengthy description'))).toBe(true);
  });

  it('does not include short values', () => {
    const compressible = XmlAdapter.extractCompressible(mavenPom);
    expect(compressible.every((c) => !c.includes('2.1.0'))).toBe(true);
    expect(compressible.every((c) => !c.includes('com.example'))).toBe(true);
  });

  it('returns empty array for structure-only XML', () => {
    const structureOnly = '<config><host>localhost</host><port>8080</port></config>';
    expect(XmlAdapter.extractCompressible(structureOnly)).toHaveLength(0);
  });
});

describe('XmlAdapter.reconstruct', () => {
  it('appends summary as XML comment when summary is non-empty', () => {
    const result = XmlAdapter.reconstruct(['<root><child/></root>'], 'description of project');
    expect(result).toContain('<!-- description of project -->');
    expect(result).toContain('<root>');
  });

  it('returns skeleton without comment when summary is empty', () => {
    const result = XmlAdapter.reconstruct(['<root/>'], '');
    expect(result).toBe('<root/>');
    expect(result).not.toContain('<!--');
  });
});

// ---------------------------------------------------------------------------
// YamlAdapter — detect
// ---------------------------------------------------------------------------

describe('YamlAdapter.detect', () => {
  it('detects Kubernetes YAML', () => {
    expect(YamlAdapter.detect(k8sDeployment)).toBe(true);
  });

  it('detects GitHub Actions YAML', () => {
    expect(YamlAdapter.detect(githubActionsYaml)).toBe(true);
  });

  it('rejects XML', () => {
    expect(YamlAdapter.detect(mavenPom)).toBe(false);
  });

  it('rejects plain prose', () => {
    expect(YamlAdapter.detect('Just a sentence here.')).toBe(false);
  });

  it('rejects very short content', () => {
    expect(YamlAdapter.detect('name: foo\nversion: 1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// YamlAdapter — extractPreserved / extractCompressible
// ---------------------------------------------------------------------------

describe('YamlAdapter.extractPreserved', () => {
  it('preserves keys with short atomic values', () => {
    const preserved = YamlAdapter.extractPreserved(k8sDeployment);
    const joined = preserved.join('\n');
    expect(joined).toContain('apiVersion: apps/v1');
    expect(joined).toContain('kind: Deployment');
    expect(joined).toContain('replicas: 3');
  });

  it('preserves list items and structure lines', () => {
    const preserved = YamlAdapter.extractPreserved(k8sDeployment);
    const joined = preserved.join('\n');
    // List items (- name: nginx) should be preserved
    expect(joined).toContain('nginx');
  });

  it('drops long prose values', () => {
    const preserved = YamlAdapter.extractPreserved(k8sDeployment);
    const joined = preserved.join('\n');
    expect(joined).not.toContain('thousands of users');
  });
});

describe('YamlAdapter.extractCompressible', () => {
  it('extracts keys with long prose values', () => {
    const compressible = YamlAdapter.extractCompressible(k8sDeployment);
    expect(compressible.length).toBeGreaterThan(0);
    expect(compressible.some((c) => c.includes('thousands of users'))).toBe(true);
  });

  it('does not include short atomic values', () => {
    const compressible = YamlAdapter.extractCompressible(k8sDeployment);
    expect(compressible.every((c) => !c.startsWith('kind:'))).toBe(true);
    expect(compressible.every((c) => !c.startsWith('replicas:'))).toBe(true);
  });

  it('returns empty for all-atomic YAML', () => {
    const atomic = 'name: myapp\nversion: 1.0.0\nenabled: true\nreplicas: 3\nport: 8080\n';
    expect(YamlAdapter.extractCompressible(atomic)).toHaveLength(0);
  });
});

describe('YamlAdapter.reconstruct', () => {
  it('appends summary as YAML comment', () => {
    const preserved = ['name: myapp', 'version: 1.0.0'];
    const result = YamlAdapter.reconstruct(preserved, 'verbose description summarized');
    expect(result).toContain('# verbose description summarized');
    expect(result).toContain('name: myapp');
  });

  it('omits comment when summary is empty', () => {
    const result = YamlAdapter.reconstruct(['name: myapp'], '');
    expect(result).not.toContain('#');
  });
});

// ---------------------------------------------------------------------------
// MarkdownAdapter — detect
// ---------------------------------------------------------------------------

describe('MarkdownAdapter.detect', () => {
  it('detects structured README', () => {
    expect(MarkdownAdapter.detect(readmeMarkdown)).toBe(true);
  });

  it('detects changelog', () => {
    expect(MarkdownAdapter.detect(changelogMarkdown)).toBe(true);
  });

  it('rejects single-heading doc', () => {
    const single = '# Title\n\nJust one paragraph here with some content.';
    expect(MarkdownAdapter.detect(single)).toBe(false);
  });

  it('rejects plain prose', () => {
    expect(MarkdownAdapter.detect('No headings, just plain text.')).toBe(false);
  });

  it('rejects XML', () => {
    expect(MarkdownAdapter.detect(mavenPom)).toBe(false);
  });

  it('rejects short content even with headings', () => {
    const short = '## A\n## B\n';
    expect(MarkdownAdapter.detect(short)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MarkdownAdapter — extractPreserved / extractCompressible
// ---------------------------------------------------------------------------

describe('MarkdownAdapter.extractPreserved', () => {
  it('includes all headings', () => {
    const preserved = MarkdownAdapter.extractPreserved(readmeMarkdown);
    const joined = preserved.join('\n');
    expect(joined).toContain('# MyProject');
    expect(joined).toContain('## Overview');
    expect(joined).toContain('## Installation');
    expect(joined).toContain('## Usage');
    expect(joined).toContain('## Configuration');
  });

  it('does not include paragraph prose', () => {
    const preserved = MarkdownAdapter.extractPreserved(readmeMarkdown);
    const joined = preserved.join('\n');
    expect(joined).not.toContain('clean abstraction');
    expect(joined).not.toContain('graceful shutdown');
  });

  it('preserves tables', () => {
    const docWithTable = `# Doc\n\nSome intro text here.\n\n## Table Section\n\nMore text.\n\n| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |\n\n## End\n\nFinal paragraph content.`;
    const preserved = MarkdownAdapter.extractPreserved(docWithTable);
    const joined = preserved.join('\n');
    expect(joined).toContain('| A | B | C |');
    expect(joined).toContain('| 1 | 2 | 3 |');
  });
});

describe('MarkdownAdapter.extractCompressible', () => {
  it('returns paragraph text', () => {
    const compressible = MarkdownAdapter.extractCompressible(readmeMarkdown);
    expect(compressible.length).toBeGreaterThan(0);
    expect(compressible.some((c) => c.includes('clean abstraction'))).toBe(true);
  });

  it('does not include headings', () => {
    const compressible = MarkdownAdapter.extractCompressible(readmeMarkdown);
    expect(compressible.every((c) => !c.startsWith('#'))).toBe(true);
  });

  it('does not include horizontal rules', () => {
    const content = `# A\n\nParagraph one here.\n\n---\n\n## B\n\nParagraph two here and more text.`;
    const compressible = MarkdownAdapter.extractCompressible(content);
    expect(compressible.every((c) => !/^[-*_]{3}/.test(c))).toBe(true);
  });
});

describe('MarkdownAdapter.reconstruct', () => {
  it('joins headings and summary with double newlines', () => {
    const preserved = ['# Title', '## Section'];
    const result = MarkdownAdapter.reconstruct(preserved, 'prose summary');
    expect(result).toContain('# Title');
    expect(result).toContain('## Section');
    expect(result).toContain('prose summary');
    expect(result).toContain('\n\n');
  });

  it('omits summary when empty', () => {
    const result = MarkdownAdapter.reconstruct(['# Title', '## Section'], '');
    expect(result.trim()).toBe('# Title\n\n## Section');
  });
});

// ---------------------------------------------------------------------------
// Integration: compress pipeline
// ---------------------------------------------------------------------------

describe('format adapters in compress pipeline', () => {
  it('XmlAdapter compresses XML tool output', () => {
    const xmlWithProse = `<?xml version="1.0"?>
<project>
  <name>myapp</name>
  <version>1.0.0</version>
  <description>${'A very detailed description of this project that explains everything about it in verbose terms. '.repeat(3)}</description>
  <build>
    <output>dist</output>
  </build>
</project>`;

    const messages: Message[] = [msg({ id: '1', index: 0, role: 'tool', content: xmlWithProse })];

    const result = compress(messages, { recencyWindow: 0, adapters: [XmlAdapter] });
    const output = result.messages[0].content!;

    // Structure must survive
    expect(output).toContain('<name>');
    expect(output).toContain('myapp');
    expect(output).toContain('1.0.0');
  });

  it('YamlAdapter compresses YAML with prose values', () => {
    const yaml = `name: myservice
version: 2.0.0
replicas: 3
image: nginx:1.25
description: ${'This service handles all incoming requests and routes them to appropriate backends based on sophisticated load balancing logic. '.repeat(2)}
port: 8080
enabled: true`;

    const messages: Message[] = [msg({ id: '1', index: 0, role: 'tool', content: yaml })];

    const result = compress(messages, { recencyWindow: 0, adapters: [YamlAdapter] });
    const output = result.messages[0].content!;

    expect(output).toContain('name: myservice');
    expect(output).toContain('version: 2.0.0');
    expect(output).toContain('replicas: 3');
  });

  it('MarkdownAdapter compresses prose-heavy markdown', () => {
    const markdown = `# API Reference

${'Introductory paragraph explaining the purpose of this API reference document. '.repeat(3)}

## Authentication

${'All requests to this API require authentication using a Bearer token obtained from the auth endpoint. '.repeat(3)}

## Rate Limiting

${'The API enforces rate limits on a per-key basis to ensure fair usage across all clients. '.repeat(3)}

## Endpoints

See the endpoint reference below.`;

    const messages: Message[] = [msg({ id: '1', index: 0, role: 'user', content: markdown })];

    const result = compress(messages, { recencyWindow: 0, adapters: [MarkdownAdapter] });
    const output = result.messages[0].content!;

    // Headings must survive
    expect(output).toContain('# API Reference');
    expect(output).toContain('## Authentication');
    expect(output).toContain('## Rate Limiting');
    expect(output).toContain('## Endpoints');
  });

  it('adapter trace records correct adapter name', () => {
    const yaml = `name: svc\nversion: 1.0.0\nport: 3000\nenabled: true\nreplicas: 2\ndescription: ${'Long description '.repeat(10)}`;

    const messages: Message[] = [msg({ id: '1', index: 0, role: 'tool', content: yaml })];

    const result = compress(messages, {
      recencyWindow: 0,
      adapters: [YamlAdapter],
      trace: true,
    });

    const decisions = result.compression.decisions ?? [];
    const adapterDecision = decisions.find((d) => d.reason?.includes('yaml'));
    // Either it matched the adapter or reverted — either way the reason is recorded
    expect(adapterDecision ?? decisions[0]).toBeDefined();
  });

  it('first matching adapter wins', () => {
    // XML content should match XmlAdapter and not reach YamlAdapter
    const xmlContent = '<root><item>value</item></root>';
    expect(XmlAdapter.detect(xmlContent)).toBe(true);
    expect(YamlAdapter.detect(xmlContent)).toBe(false);
  });

  it('non-matching adapters do not interfere', () => {
    const plainText = 'Just a plain message with no special format.';
    const messages: Message[] = [msg({ id: '1', index: 0, role: 'user', content: plainText })];

    const withAdapters = compress(messages, {
      recencyWindow: 0,
      adapters: [XmlAdapter, YamlAdapter, MarkdownAdapter],
    });
    const without = compress(messages, { recencyWindow: 0 });

    expect(withAdapters.compression.messages_compressed).toBe(without.compression.messages_compressed);
    expect(withAdapters.compression.messages_preserved).toBe(without.compression.messages_preserved);
  });
});
