/**
 * Utility functions for safely creating Discord embeds with proper size limits.
 * Discord embed limits: 6000 chars total, 1024 chars per field, 25 fields max.
 */
export function enforceEmbedLimits(embed: any, title: string, description: string, fields: { name: string; value: string }[]): void {
  // Truncate description
  if (description.length > 1024) {
    description = description.slice(0, 1021) + '...';
  }
  
  // Process fields with truncation
  const processedFields = fields.slice(0, 25).map(field => ({
    name: field.name.length > 256 ? field.name.slice(0, 253) + '...' : field.name,
    value: field.value.length > 1024 ? field.value.slice(0, 1021) + '...' : field.value
  }));
  
  // Set embed properties
  embed.setTitle(title);
  embed.setDescription(description);
  embed.addFields(...processedFields);
  
  // Check total length - if over 6000, truncate description further
  const totalLength = description.length + processedFields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
  if (totalLength > 6000) {
    const excess = totalLength - 6000;
    const newDescLength = Math.max(0, description.length - excess);
    embed.setDescription(description.slice(0, newDescLength));
  }
}
<<<<<<< REPLACE
```