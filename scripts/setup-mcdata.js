const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

function setupMinecraftData () {
  const mcDataDir = path.join(__dirname, '..', 'node_modules', 'minecraft-data')
  if (!fs.existsSync(mcDataDir)) {
    console.log('[setup-mcdata] node_modules/minecraft-data not found, skipping.')
    return
  }

  // Check if 26.3 is already supported
  try {
    const md = require('minecraft-data')
    if (md('26.3')) {
      console.log('[setup-mcdata] Minecraft 26.3 is already supported in minecraft-data.')
      return
    }
  } catch (_) {}

  console.log('[setup-mcdata] Patching minecraft-data to support Minecraft 26.3...')
  const targetDir = path.join(mcDataDir, 'minecraft-data')
  const backupDir = path.join(mcDataDir, 'minecraft-data-old')

  try {
    if (fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true, force: true })
    }
    if (fs.existsSync(targetDir)) {
      fs.renameSync(targetDir, backupDir)
    }

    console.log('[setup-mcdata] Cloning 26.3 data from https://github.com/suisarbre/minecraft-data...')
    execSync('git clone -b port-26.3 --depth 1 https://github.com/suisarbre/minecraft-data.git "' + targetDir + '"', {
      stdio: 'inherit'
    })

    console.log('[setup-mcdata] Generating data.js in minecraft-data...')
    execSync('node bin/generate_data.js', {
      cwd: mcDataDir,
      stdio: 'inherit'
    })

    // Verify
    delete require.cache[require.resolve('minecraft-data')]
    delete require.cache[path.join(mcDataDir, 'data.js')]
    delete require.cache[path.join(mcDataDir, 'index.js')]
    const md = require('minecraft-data')
    if (md('26.3')) {
      console.log('[setup-mcdata] Successfully configured Minecraft 26.3 support!')
    } else {
      console.warn('[setup-mcdata] Warning: 26.3 was generated but lookup failed.')
    }
  } catch (err) {
    console.error('[setup-mcdata] Error patching minecraft-data:', err.message)
    if (!fs.existsSync(targetDir) && fs.existsSync(backupDir)) {
      try { fs.renameSync(backupDir, targetDir) } catch (_) {}
    }
  }
}

setupMinecraftData()
