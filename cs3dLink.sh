## cornerstone 3d / core
cd packages/core

sed -i '' 's/dist\/esm\/index.js/src\/index.ts/g' ./package.json
sed -i '' 's/dist\/umd\/index.js/src\/index.ts/g' ./package.json

yarn unlink

yarn link

echo "*****************************************"

## cornerstone 3d / tools
cd ../tools

sed -i '' 's/dist\/esm\/index.js/src\/index.ts/g' ./package.json
sed -i '' 's/dist\/umd\/index.js/src\/index.ts/g' ./package.json

yarn unlink

yarn link @cornerstonejs/core

yarn link

echo "*****************************************"

## cornerstone 3d / streaming

cd ../streaming-image-volume-loader

sed -i '' 's/dist\/esm\/index.js/src\/index.ts/g' ./package.json
sed -i '' 's/dist\/umd\/index.js/src\/index.ts/g' ./package.json

yarn unlink

yarn link @cornerstonejs/core

yarn link

echo "*****************************************"
## run the yarn webpack:watch with concurrently for the three packages

cd ../..

concurrently "cd packages/core yarn webpack:watch" "cd packages/tools && yarn webpack:watch" "cd packages/streaming-image-volume-loader && yarn webpack:watch"
