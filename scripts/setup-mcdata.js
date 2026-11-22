const fs = require('fs')
const path = require('path')

function setupMinecraftData () {
  console.log('[setup-mcdata] Initializing Minecraft 26.3 patch for Render / CI / Local...')
  
  // 1. Remove nested outdated minecraft-protocol inside mineflayer if present
  const nestedProtocol = path.join(__dirname, '..', 'node_modules', 'mineflayer', 'node_modules', 'minecraft-protocol')
  if (fs.existsSync(nestedProtocol)) {
    console.log('[setup-mcdata] Removing outdated nested minecraft-protocol from mineflayer...')
    fs.rmSync(nestedProtocol, { recursive: true, force: true })
  }

  // 2. Patch minecraft-data with 26.3 tables
  const mcDataDir = path.join(__dirname, '..', 'node_modules', 'minecraft-data')
  if (!fs.existsSync(mcDataDir)) {
    console.log('[setup-mcdata] node_modules/minecraft-data not found, skipping.')
    return
  }

  const patchesDir = path.join(__dirname, '..', 'patches', 'mcdata')
  if (!fs.existsSync(patchesDir)) {
    console.error('[setup-mcdata] patches/mcdata directory not found!')
    return
  }

  const mcDataDataDir = path.join(mcDataDir, 'minecraft-data', 'data')
  const pcDir = path.join(mcDataDataDir, 'pc')
  const commonDir = path.join(pcDir, 'common')

  try {
    fs.mkdirSync(pcDir, { recursive: true })
    fs.mkdirSync(commonDir, { recursive: true })

    // Copy all patched pc directories and files (26.3, 26.2, 26.1, 1.20.3, latest)
    fs.cpSync(path.join(patchesDir, 'pc'), pcDir, { recursive: true })
    fs.cpSync(path.join(patchesDir, 'common'), commonDir, { recursive: true })
    fs.copyFileSync(path.join(patchesDir, 'dataPaths.json'), path.join(mcDataDataDir, 'dataPaths.json'))
    fs.copyFileSync(path.join(patchesDir, 'data.js'), path.join(mcDataDir, 'data.js'))

    // Verify
    delete require.cache[require.resolve('minecraft-data')]
    delete require.cache[path.join(mcDataDir, 'data.js')]
    delete require.cache[path.join(mcDataDir, 'index.js')]
    const md = require('minecraft-data')
    const v26_3 = md('26.3')
    if (v26_3 && v26_3.version) {
      console.log(`[setup-mcdata] SUCCESS: Minecraft ${v26_3.version.minecraftVersion} (protocol ${v26_3.version.version}) is active in minecraft-data!`)
    } else {
      throw new Error('Verification failed: minecraft-data("26.3") returned null or undefined.')
    }
  } catch (err) {
    console.error('[setup-mcdata] Patch failed:', err)
    process.exit(1)
  }
}

setupMinecraftData()
