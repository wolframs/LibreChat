import { formatToolContent } from '../parsers';
import type * as t from '../types';

describe('formatToolContent', () => {
  describe('unrecognized providers', () => {
    it('should return string for unrecognized provider', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          { type: 'text', text: 'Hello world' },
          { type: 'text', text: 'Another text' },
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'unknown' as t.Provider);
      expect(content).toBe('Hello world\n\nAnother text');
      expect(artifacts).toBeUndefined();
    });

    it('should return "(No response)" for empty content with unrecognized provider', () => {
      const result: t.MCPToolCallResponse = { content: [] };
      const [content, artifacts] = formatToolContent(result, 'unknown' as t.Provider);
      expect(content).toBe('(No response)');
      expect(artifacts).toBeUndefined();
    });

    it('should return "(No response)" for undefined result with unrecognized provider', () => {
      const result: t.MCPToolCallResponse = undefined;
      const [content, artifacts] = formatToolContent(result, 'unknown' as t.Provider);
      expect(content).toBe('(No response)');
      expect(artifacts).toBeUndefined();
    });

    it('should name an image rather than paste its base64 for unrecognized providers', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'image', data: 'iVBORw0KGgoAAAA...', mimeType: 'image/png' }],
      };

      const [content, artifacts] = formatToolContent(result, 'unknown' as t.Provider);

      expect(artifacts).toBeUndefined();
      expect(content).not.toContain('iVBORw0KGgoAAAA...');
      expect(content).toContain('image/png');
      expect(content).toContain('not delivered');
    });

    it('should keep a remote image URL, which the model can still act on', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'image', data: 'https://example.com/a.png', mimeType: 'image/png' }],
      };

      const [content] = formatToolContent(result, 'unknown' as t.Provider);

      expect(content).toContain('https://example.com/a.png');
    });

    it('should name an audio block rather than paste its base64', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'audio', data: 'QUJDRA=='.repeat(200), mimeType: 'audio/mpeg' }],
      };

      const [content] = formatToolContent(result, 'unknown' as t.Provider);

      expect(content).not.toContain('QUJDRA==');
      expect(content).toContain('audio/mpeg');
    });

    it('should elide oversized strings from unknown content types', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          { type: 'video', data: 'A'.repeat(4096), mimeType: 'video/mp4' },
        ] as unknown as t.ToolContentPart[],
      };

      const [content] = formatToolContent(result, 'unknown' as t.Provider);

      expect(content).not.toContain('A'.repeat(600));
      expect(content).toContain('4096 characters omitted');
      expect(content).toContain('video/mp4');
    });
  });

  describe('recognized providers', () => {
    const allProviders: t.Provider[] = [
      'google',
      'vertexai',
      'anthropic',
      'openai',
      'azureopenai',
      'openrouter',
      'xai',
      'deepseek',
      'ollama',
      'bedrock',
    ];

    allProviders.forEach((provider) => {
      describe(`${provider} provider`, () => {
        it('should format text content as string', () => {
          const result: t.MCPToolCallResponse = {
            content: [
              { type: 'text', text: 'First text' },
              { type: 'text', text: 'Second text' },
            ],
          };

          const [content, artifacts] = formatToolContent(result, provider);
          expect(content).toBe('First text\n\nSecond text');
          expect(artifacts).toBeUndefined();
        });

        it('should extract images to artifacts and keep text as string', () => {
          const result: t.MCPToolCallResponse = {
            content: [
              { type: 'text', text: 'Before image' },
              { type: 'image', data: 'base64data', mimeType: 'image/png' },
              { type: 'text', text: 'After image' },
            ],
          };

          const [content, artifacts] = formatToolContent(result, provider);
          expect(content).toBe('Before image\n\nAfter image');
          expect(artifacts).toEqual({
            content: [
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,base64data' },
              },
            ],
          });
        });

        it('should handle empty content', () => {
          const result: t.MCPToolCallResponse = { content: [] };
          const [content, artifacts] = formatToolContent(result, provider);
          expect(content).toBe('(No response)');
          expect(artifacts).toBeUndefined();
        });
      });
    });
  });

  describe('image handling', () => {
    const originalMaxImageBytes = process.env.MCP_IMAGE_DATA_MAX_BYTES;

    afterEach(() => {
      if (originalMaxImageBytes === undefined) {
        delete process.env.MCP_IMAGE_DATA_MAX_BYTES;
        return;
      }
      process.env.MCP_IMAGE_DATA_MAX_BYTES = originalMaxImageBytes;
    });

    it('should handle images with http URLs', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'image', data: 'https://example.com/image.png', mimeType: 'image/png' }],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');
      expect(content).toBe('');
      expect(artifacts).toEqual({
        content: [
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/image.png' },
          },
        ],
      });
    });

    it('should handle images with base64 data', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'image', data: 'iVBORw0KGgoAAAA...', mimeType: 'image/png' }],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');
      expect(content).toBe('');
      expect(artifacts).toEqual({
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAA...' },
          },
        ],
      });
    });

    it('should return empty string for image-only content when artifacts exist', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'image', data: 'base64data', mimeType: 'image/png' }],
      };
      const [content, artifacts] = formatToolContent(result, 'anthropic');
      expect(content).toBe('');
      expect(artifacts).toBeDefined();
      expect(artifacts?.content).toHaveLength(1);
    });

    it('should lift a server-supplied file_id from _meta into artifacts.file_ids', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          { type: 'text', text: 'Image generated successfully.' },
          {
            type: 'image',
            data: 'base64data',
            mimeType: 'image/webp',
            _meta: { 'librechat/file_id': 'a5e0f1c2-0000-4000-8000-000000000001' },
          },
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'anthropic');

      expect(content).toBe('Image generated successfully.');
      expect(artifacts?.file_ids).toEqual(['a5e0f1c2-0000-4000-8000-000000000001']);
    });

    it('should keep file_ids index-aligned with artifact content', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          { type: 'image', data: 'first', mimeType: 'image/png' },
          {
            type: 'image',
            data: 'second',
            mimeType: 'image/png',
            _meta: { 'librechat/file_id': 'second-id' },
          },
        ],
      };

      const [, artifacts] = formatToolContent(result, 'openai');

      expect(artifacts?.content).toHaveLength(2);
      expect(artifacts?.file_ids).toEqual([undefined, 'second-id']);
    });

    it('should omit file_ids entirely when no image carries one', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          { type: 'image', data: 'base64data', mimeType: 'image/png', _meta: { unrelated: 1 } },
        ],
      };

      const [, artifacts] = formatToolContent(result, 'openai');

      expect(artifacts?.content).toHaveLength(1);
      expect(artifacts?.file_ids).toBeUndefined();
    });

    it('should ignore a non-string file_id in _meta', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          {
            type: 'image',
            data: 'base64data',
            mimeType: 'image/png',
            _meta: { 'librechat/file_id': 42 },
          },
        ],
      };

      const [, artifacts] = formatToolContent(result, 'openai');

      expect(artifacts?.file_ids).toBeUndefined();
    });

    it('should handle multiple images without text', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          { type: 'image', data: 'https://example.com/a.png', mimeType: 'image/png' },
          { type: 'image', data: 'https://example.com/b.jpg', mimeType: 'image/jpeg' },
        ],
      };
      const [content, artifacts] = formatToolContent(result, 'google');
      expect(content).toBe('');
      expect(artifacts).toBeDefined();
      expect(artifacts?.content).toHaveLength(2);
    });

    it('should produce artifacts on vertexai, as it does on google', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'image', data: 'QUJDRA==', mimeType: 'image/png' }],
      };

      const [content, artifacts] = formatToolContent(result, 'vertexai');

      expect(content).toBe('');
      expect(artifacts?.content).toEqual([
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJDRA==' } },
      ]);
    });

    it('should name an audio block for recognized providers, keeping other content', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          { type: 'text', text: 'Here is the recording.' },
          { type: 'audio', data: 'QUJDRA=='.repeat(200), mimeType: 'audio/mpeg' },
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'anthropic');

      expect(artifacts).toBeUndefined();
      expect(content).toContain('Here is the recording.');
      expect(content).toContain('audio not delivered');
      expect(content).not.toContain('QUJDRA==');
    });

    it('should elide oversized strings from unknown content types', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          { type: 'video', data: 'A'.repeat(4096), mimeType: 'video/mp4' },
        ] as unknown as t.ToolContentPart[],
      };

      const [content] = formatToolContent(result, 'anthropic');

      expect(content).not.toContain('A'.repeat(600));
      expect(content).toContain('4096 characters omitted');
    });

    it('should drop an oversized image without creating artifacts', () => {
      process.env.MCP_IMAGE_DATA_MAX_BYTES = '3';
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'image', data: 'QUJDRA==', mimeType: 'image/png' }],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');

      expect(artifacts).toBeUndefined();
      expect(content).toContain('image not delivered');
      expect(content).toContain('MCP_IMAGE_DATA_MAX_BYTES');
    });

    it('should keep the text blocks that accompany an oversized image', () => {
      process.env.MCP_IMAGE_DATA_MAX_BYTES = '3';
      const result: t.MCPToolCallResponse = {
        content: [
          { type: 'text', text: 'Image generated successfully. file_id: abc' },
          { type: 'image', data: 'QUJDRA==', mimeType: 'image/png' },
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'anthropic');

      expect(artifacts).toBeUndefined();
      expect(content).toContain('Image generated successfully. file_id: abc');
      expect(content).toContain('image not delivered');
    });

    it('should still deliver the images that fit alongside one that does not', () => {
      process.env.MCP_IMAGE_DATA_MAX_BYTES = '4';
      const result: t.MCPToolCallResponse = {
        content: [
          { type: 'image', data: 'QUJDRA==', mimeType: 'image/png' },
          { type: 'image', data: 'QUJDRAVGRw==', mimeType: 'image/png' },
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');

      expect(artifacts?.content).toHaveLength(1);
      expect(artifacts?.content?.[0]).toEqual({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,QUJDRA==' },
      });
      expect(content).toContain('image not delivered');
    });

    it('should allow base64 image data when decoded size is within the cap', () => {
      process.env.MCP_IMAGE_DATA_MAX_BYTES = '4';
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'image', data: 'QUJDRA==', mimeType: 'image/png' }],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');

      expect(content).toBe('');
      expect(artifacts?.content?.[0]).toEqual({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,QUJDRA==' },
      });
    });

    it('should name, not paste, oversized image data for unrecognized providers', () => {
      process.env.MCP_IMAGE_DATA_MAX_BYTES = '3';
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'image', data: 'QUJDRA==', mimeType: 'image/png' }],
      };

      const [content] = formatToolContent(result, 'unknown' as t.Provider);

      expect(content).not.toContain('QUJDRA==');
      expect(content).toContain('image not delivered');
    });

    it('should not apply the image data cap to remote image URLs', () => {
      process.env.MCP_IMAGE_DATA_MAX_BYTES = '3';
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'image', data: 'https://example.com/large.png', mimeType: 'image/png' }],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');

      expect(content).toBe('');
      expect(artifacts?.content?.[0]).toEqual({
        type: 'image_url',
        image_url: { url: 'https://example.com/large.png' },
      });
    });

    it('should enforce the image cap on base64 data that merely starts with "http"', () => {
      process.env.MCP_IMAGE_DATA_MAX_BYTES = '3';
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'image', data: 'httpAAAAAAAA', mimeType: 'image/png' }],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');

      expect(artifacts).toBeUndefined();
      expect(content).toContain('image not delivered');
    });

    it('should treat base64 starting with "http" as inline data, not a remote URL', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'image', data: 'httpAAAA', mimeType: 'image/png' }],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');

      expect(content).toBe('');
      expect(artifacts?.content?.[0]).toEqual({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,httpAAAA' },
      });
    });
  });

  describe('resource handling', () => {
    it('should handle UI resources in artifacts', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          {
            type: 'resource',
            resource: {
              uri: 'ui://carousel',
              mimeType: 'application/json',
              text: '{"items": []}',
            },
          },
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');
      expect(typeof content).toBe('string');
      expect(content).toContain('UI Resource ID:');
      expect(content).toContain('UI Resource Marker: \\ui{');
      expect(content).toContain('Resource URI: ui://carousel');
      expect(content).toContain('Resource MIME Type: application/json');

      const uiResourceArtifact = artifacts?.ui_resources?.data?.[0];
      expect(uiResourceArtifact).toBeTruthy();
      expect(uiResourceArtifact).toMatchObject({
        uri: 'ui://carousel',
        mimeType: 'application/json',
        text: '{"items": []}',
      });
      expect(uiResourceArtifact?.resourceId).toEqual(expect.any(String));
    });

    it('should handle regular resources', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          {
            type: 'resource',
            resource: {
              uri: 'file://document.pdf',
              mimeType: 'application/pdf',
              text: 'Document content',
            },
          },
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');
      expect(content).toBe(
        'Resource Text: Document content\n' +
          'Resource URI: file://document.pdf\n' +
          'Resource MIME Type: application/pdf',
      );
      expect(artifacts).toBeUndefined();
    });

    it('should deliver an image returned as an embedded blob resource', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          {
            type: 'resource',
            resource: {
              uri: 'file:///out/apple.png',
              mimeType: 'image/png',
              blob: 'QUJDRA==',
            },
          },
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'anthropic');

      expect(artifacts?.content).toEqual([
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJDRA==' } },
      ]);
      expect(content).toContain('Resource URI: file:///out/apple.png');
      expect(content).not.toContain('QUJDRA==');
    });

    it('should read a server-chosen file_id off a blob resource', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          {
            type: 'resource',
            resource: {
              uri: 'file:///out/apple.png',
              mimeType: 'image/png',
              blob: 'QUJDRA==',
              _meta: { 'librechat/file_id': 'blob-id' },
            },
          },
        ],
      };

      const [, artifacts] = formatToolContent(result, 'openai');

      expect(artifacts?.file_ids).toEqual(['blob-id']);
    });

    it('should describe a non-image blob resource instead of dropping it silently', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          {
            type: 'resource',
            resource: {
              uri: 'file:///out/report.pdf',
              mimeType: 'application/pdf',
              blob: 'QUJDRA=='.repeat(100),
            },
          },
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');

      expect(artifacts).toBeUndefined();
      expect(content).toContain('bytes, not delivered inline');
      expect(content).toContain('Resource URI: file:///out/report.pdf');
      expect(content).not.toContain('QUJDRA==');
    });

    it('should handle resources with partial data', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          {
            type: 'resource',
            resource: {
              uri: 'https://example.com/resource',
              text: '',
            },
          },
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');
      expect(content).toBe('Resource URI: https://example.com/resource');
      expect(artifacts).toBeUndefined();
    });

    it('should handle mixed UI and regular resources', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          { type: 'text', text: 'Some text' },
          {
            type: 'resource',
            resource: {
              uri: 'ui://button',
              mimeType: 'application/json',
              text: '{"label": "Click me"}',
            },
          },
          {
            type: 'resource',
            resource: {
              uri: 'file://data.csv',
              text: '',
            },
          },
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');
      expect(typeof content).toBe('string');
      expect(content).toContain('Some text');
      expect(content).toContain('UI Resource Marker: \\ui{');
      expect(content).toContain('Resource URI: ui://button');
      expect(content).toContain('Resource MIME Type: application/json');
      expect(content).toContain('Resource URI: file://data.csv');

      const uiResource = artifacts?.ui_resources?.data?.[0];
      expect(uiResource).toMatchObject({
        uri: 'ui://button',
        mimeType: 'application/json',
        text: '{"label": "Click me"}',
      });
      expect(uiResource?.resourceId).toEqual(expect.any(String));
    });

    it('should handle both images and UI resources in artifacts', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          { type: 'text', text: 'Content with multimedia' },
          { type: 'image', data: 'base64imagedata', mimeType: 'image/png' },
          {
            type: 'resource',
            resource: {
              uri: 'ui://graph',
              mimeType: 'application/json',
              text: '{"type": "line"}',
            },
          },
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');
      expect(typeof content).toBe('string');
      expect(content).toContain('Content with multimedia');
      expect(content).toContain('UI Resource Marker: \\ui{');
      expect(content).toContain('Resource URI: ui://graph');
      expect(content).toContain('Resource MIME Type: application/json');
      expect(artifacts).toEqual({
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,base64imagedata' },
          },
        ],
        ui_resources: {
          data: [
            {
              uri: 'ui://graph',
              mimeType: 'application/json',
              text: '{"type": "line"}',
              resourceId: expect.any(String),
            },
          ],
        },
      });
    });
  });

  describe('unknown content types', () => {
    it('should stringify unknown content types', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          { type: 'text', text: 'Normal text' },
          { type: 'unknown', data: 'some data' } as unknown as t.ToolContentPart,
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');
      expect(content).toBe(
        'Normal text\n\n' + JSON.stringify({ type: 'unknown', data: 'some data' }, null, 2),
      );
      expect(artifacts).toBeUndefined();
    });
  });

  describe('complex scenarios', () => {
    it('should handle mixed content with all types', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          { type: 'text', text: 'Introduction' },
          { type: 'image', data: 'image1.png', mimeType: 'image/png' },
          { type: 'text', text: 'Middle section' },
          {
            type: 'resource',
            resource: {
              uri: 'ui://chart',
              mimeType: 'application/json',
              text: '{"type": "bar"}',
            },
          },
          {
            type: 'resource',
            resource: {
              uri: 'https://api.example.com/data',
              text: '',
            },
          },
          { type: 'image', data: 'https://example.com/image2.jpg', mimeType: 'image/jpeg' },
          { type: 'text', text: 'Conclusion' },
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'anthropic');
      expect(typeof content).toBe('string');
      expect(content).toContain('Introduction');
      expect(content).toContain('Middle section');
      expect(content).toContain('UI Resource ID:');
      expect(content).toContain('UI Resource Marker: \\ui{');
      expect(content).toContain('Resource URI: ui://chart');
      expect(content).toContain('Resource MIME Type: application/json');
      expect(content).toContain('Resource URI: https://api.example.com/data');
      expect(content).toContain('Conclusion');
      expect(content).toContain('UI Resource Markers Available:');
      expect(artifacts).toMatchObject({
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,image1.png' },
          },
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/image2.jpg' },
          },
        ],
        ui_resources: {
          data: [
            {
              uri: 'ui://chart',
              mimeType: 'application/json',
              text: '{"type": "bar"}',
              resourceId: expect.any(String),
            },
          ],
        },
      });
    });

    it('should handle error responses gracefully', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'text', text: 'Error occurred' }],
        isError: true,
      };

      const [content, artifacts] = formatToolContent(result, 'openai');
      expect(content).toBe('Error occurred');
      expect(artifacts).toBeUndefined();
    });

    it('should handle metadata in responses', () => {
      const result: t.MCPToolCallResponse = {
        _meta: { timestamp: Date.now(), source: 'test' },
        content: [{ type: 'text', text: 'Response with metadata' }],
      };

      const [content, artifacts] = formatToolContent(result, 'google');
      expect(content).toBe('Response with metadata');
      expect(artifacts).toBeUndefined();
    });
  });
});
