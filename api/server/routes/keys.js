const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { DEFAULT_ENDPOINT_PROFILE_ID } = require('librechat-data-provider');
const { parseUserKeyBlob, validateEndpointURL } = require('@librechat/api');
const { updateUserKey, deleteUserKey, getUserKeyExpiry, getUserKey } = require('~/models');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();

/** Caps on the stored profile set. Generous for real use, bounded for storage. */
const MAX_PROFILES = 20;
const MAX_FIELD_LENGTH = 2048;

/**
 * Reads a user's key blob without failing when none exists. Profiles are usable
 * on endpoints where the admin supplies the credential, so "no stored key" is a
 * normal state here rather than an error.
 * @param {string} userId
 * @param {string} name
 * @returns {Promise<import('@librechat/api').UserKeyValues | null>}
 */
async function readKeyBlob(userId, name) {
  try {
    return parseUserKeyBlob(await getUserKey({ userId, name }));
  } catch (error) {
    logger.debug(`[keys] no readable key blob for ${name}: ${error.message}`);
    return null;
  }
}

/**
 * Strips secrets from a stored profile for transport to the browser.
 * The key itself is never returned — only enough of a tail to tell two
 * saved keys apart.
 */
function maskProfile(profile) {
  const apiKey = typeof profile.apiKey === 'string' ? profile.apiKey : '';
  return {
    id: profile.id,
    name: profile.name,
    baseURL: profile.baseURL,
    hasApiKey: apiKey.length > 0,
    apiKeyHint: apiKey.length > 4 ? apiKey.slice(-4) : undefined,
  };
}

/** Rejects anything that isn't a plain absolute http(s) URL. */
function isValidBaseURL(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

router.put('/', requireJwtAuth, async (req, res) => {
  if (req.body == null || typeof req.body !== 'object') {
    return res.status(400).send({ error: 'Invalid request body.' });
  }
  const { name, value, expiresAt } = req.body;
  await updateUserKey({ userId: req.user.id, name, value, expiresAt });
  res.status(201).send();
});

/**
 * Endpoint profiles for one provider, with API keys masked.
 *
 * Deliberately not part of `GET /` — that route returns only expiry, and the
 * plaintext key must never reach the browser. Editing a profile without
 * retyping its key works because the save path below merges the stored value.
 */
router.get('/profiles', requireJwtAuth, async (req, res) => {
  const { name } = req.query;
  if (!name || typeof name !== 'string') {
    return res.status(400).send({ error: 'A provider name is required.' });
  }

  const blob = await readKeyBlob(req.user.id, name);
  const stored = blob?.endpointProfiles ?? {};
  const profiles = Array.isArray(stored.profiles) ? stored.profiles : [];

  /** An `active` id pointing at a deleted profile falls back to the default
   *  rather than leaving the UI selecting nothing. */
  const activeId = stored.active ?? DEFAULT_ENDPOINT_PROFILE_ID;
  const active = profiles.some((profile) => profile.id === activeId)
    ? activeId
    : DEFAULT_ENDPOINT_PROFILE_ID;

  res.status(200).send({
    active,
    profiles: profiles.map(maskProfile),
    defaultBaseURL: blob?.baseURL || undefined,
    defaultHasApiKey: typeof blob?.apiKey === 'string' && blob.apiKey.length > 0,
  });
});

/**
 * Creates, updates, reorders, deletes, and switches endpoint profiles in one
 * write — the client always sends the full desired list.
 *
 * A profile whose `apiKey` is omitted keeps the key already stored for that id,
 * which is what makes editing a base URL possible without the browser ever
 * having seen the key.
 */
router.put('/profiles', requireJwtAuth, async (req, res) => {
  if (req.body == null || typeof req.body !== 'object') {
    return res.status(400).send({ error: 'Invalid request body.' });
  }

  const { name, active, profiles } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).send({ error: 'A provider name is required.' });
  }
  if (profiles != null && !Array.isArray(profiles)) {
    return res.status(400).send({ error: 'Profiles must be an array.' });
  }
  if (Array.isArray(profiles) && profiles.length > MAX_PROFILES) {
    return res.status(400).send({ error: `At most ${MAX_PROFILES} endpoints are supported.` });
  }

  const blob = (await readKeyBlob(req.user.id, name)) ?? {};
  const storedById = new Map(
    (blob.endpointProfiles?.profiles ?? []).map((profile) => [profile.id, profile]),
  );

  let nextProfiles = blob.endpointProfiles?.profiles ?? [];

  if (Array.isArray(profiles)) {
    const seen = new Set();
    nextProfiles = [];

    for (const profile of profiles) {
      if (profile == null || typeof profile !== 'object') {
        return res.status(400).send({ error: 'Each endpoint must be an object.' });
      }

      const id = typeof profile.id === 'string' ? profile.id.trim() : '';
      const label = typeof profile.name === 'string' ? profile.name.trim() : '';
      const baseURL = typeof profile.baseURL === 'string' ? profile.baseURL.trim() : '';

      if (!id || id === DEFAULT_ENDPOINT_PROFILE_ID) {
        return res.status(400).send({ error: 'Each endpoint needs a unique id.' });
      }
      if (seen.has(id)) {
        return res.status(400).send({ error: 'Endpoint ids must be unique.' });
      }
      seen.add(id);

      if (!label || label.length > MAX_FIELD_LENGTH) {
        return res.status(400).send({ error: 'Each endpoint needs a name.' });
      }
      if (!isValidBaseURL(baseURL) || baseURL.length > MAX_FIELD_LENGTH) {
        return res
          .status(400)
          .send({ error: `"${label}" needs a valid http(s) base URL.` });
      }

      /**
       * Block private/reserved destinations at save time rather than letting the
       * request fail mid-conversation. Admins exempt internal gateways through
       * `endpoints.allowedAddresses`.
       */
      try {
        await validateEndpointURL(baseURL, name, req.config?.endpoints?.allowedAddresses);
      } catch (error) {
        logger.warn(`[keys] rejected endpoint profile URL for ${name}: ${error.message}`);
        return res.status(400).send({
          error: `"${label}" points at a blocked address. Add it to endpoints.allowedAddresses to permit it.`,
        });
      }

      const apiKey =
        typeof profile.apiKey === 'string' && profile.apiKey.length > 0
          ? profile.apiKey
          : storedById.get(id)?.apiKey;

      if (apiKey != null && apiKey.length > MAX_FIELD_LENGTH) {
        return res.status(400).send({ error: `"${label}" has an implausibly long API key.` });
      }

      nextProfiles.push({ id, name: label, baseURL, ...(apiKey && { apiKey }) });
    }
  }

  let nextActive = blob.endpointProfiles?.active ?? DEFAULT_ENDPOINT_PROFILE_ID;
  if (typeof active === 'string' && active.length > 0) {
    if (active !== DEFAULT_ENDPOINT_PROFILE_ID && !nextProfiles.some((p) => p.id === active)) {
      return res.status(400).send({ error: 'Cannot activate an endpoint that does not exist.' });
    }
    nextActive = active;
  } else if (!nextProfiles.some((p) => p.id === nextActive)) {
    /** The active profile was just deleted — fall back rather than dangle. */
    nextActive = DEFAULT_ENDPOINT_PROFILE_ID;
  }

  const value = JSON.stringify({
    ...blob,
    endpointProfiles: { active: nextActive, profiles: nextProfiles },
  });

  /**
   * Preserve the existing expiry. Writing profiles is not a credential update,
   * so it must not silently extend — or clear — the key's lifetime.
   */
  const { expiresAt } = await getUserKeyExpiry({ userId: req.user.id, name });
  await updateUserKey({
    userId: req.user.id,
    name,
    value,
    expiresAt: expiresAt && expiresAt !== 'never' ? expiresAt : null,
  });

  res.status(200).send({ active: nextActive, profiles: nextProfiles.map(maskProfile) });
});

router.delete('/:name', requireJwtAuth, async (req, res) => {
  const { name } = req.params;
  await deleteUserKey({ userId: req.user.id, name });
  res.status(204).send();
});

router.delete('/', requireJwtAuth, async (req, res) => {
  const { all } = req.query;

  if (all !== 'true') {
    return res.status(400).send({ error: 'Specify either all=true to delete.' });
  }

  await deleteUserKey({ userId: req.user.id, all: true });

  res.status(204).send();
});

router.get('/', requireJwtAuth, async (req, res) => {
  const { name } = req.query;
  const response = await getUserKeyExpiry({ userId: req.user.id, name });
  res.status(200).send(response);
});

module.exports = router;
