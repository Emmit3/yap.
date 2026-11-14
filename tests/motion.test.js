import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tilePose, sceneState, loadPose, wallLayout } from '../public/motion.js';

test('the selected tile settles head on and fully visible on desktop and mobile', () => {
  for (const [width, height, selected] of [[1440, 900, 10], [390, 844, 7], [1024, 768, 10]]) {
    const pose = tilePose(selected, selected, 1, width, height);
    assert.equal(pose.x, 0);
    assert.equal(pose.yaw, 0);
    assert.equal(pose.opacity, 1);
    assert.ok(height / 2 + pose.y + pose.stripHeight / 2 < height, 'filmstrip stays inside viewport');
  }
});

test('all cylinder-to-strip poses stay finite, with no zero scales', () => {
  for (const width of [320, 390, 768, 1440, 2560]) {
    for (let p = 0; p <= 1; p += .025) {
      const {count} = wallLayout(width,900);
      for (let i = 0; i < count; i++) {
        const pose = tilePose(i, Math.floor(count/2), p, width, 900, .03);
        for (const value of Object.values(pose)) assert.ok(Number.isFinite(value));
        assert.ok(pose.scale > 0 && pose.opacity >= 0 && pose.opacity <= 1);
      }
    }
  }
});

test('reduced motion can use a complete final scene directly', () => {
  assert.deepEqual(sceneState(1), { intro: 0, product: 1, device: 1, rail: 1, shade: .08000000000000002 });
});

test('the load has depth and starts from the center before the outer cards', () => {
  const center=loadPose(.2,Math.floor(wallLayout(1440,900).count/2),1440,900);
  const corner=loadPose(.2,0,1440,900);
  assert.ok(center.z < -300, 'camera arrival has visible depth');
  assert.ok(center.opacity > corner.opacity, 'center arrives first');
  assert.ok(corner.pitch !== 0 && corner.roll !== 0, 'outer rows unfold in 3D');
});

test('the load settles exactly and releases the pose when scrolling early', () => {
  for(const [width,height] of [[1440,900],[390,844]]){
    const {count}=wallLayout(width,height);
    for(let index=0;index<count;index++){
      for(const pose of [loadPose(1.6,index,width,height),loadPose(.1,index,width,height,.18)]){
        for(const property of ['x','y','z','pitch','yaw','roll']) assert.equal(Math.abs(pose[property]),0);
        assert.equal(pose.scale,1);
        assert.equal(pose.opacity,1);
      }
    }
  }
});
